package com.viro.workcare

import android.app.Application
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.viro.workcare.data.AlertItem
import com.viro.workcare.data.ApiError
import com.viro.workcare.data.ComputeStatus
import com.viro.workcare.data.ControlApi
import com.viro.workcare.data.DeviceHealth
import com.viro.workcare.data.DeviceSummary
import com.viro.workcare.data.Freshness
import com.viro.workcare.data.LoginResult
import com.viro.workcare.data.PassportEvent
import com.viro.workcare.data.SecureStore
import com.viro.workcare.data.Severity
import com.viro.workcare.data.isAllowedServer
import com.viro.workcare.data.parseAlerts
import com.viro.workcare.data.parseDeviceHealth
import com.viro.workcare.data.parseDevices
import com.viro.workcare.pairing.FoundComputer
import com.viro.workcare.pairing.LanDiscovery
import com.viro.workcare.pairing.LocalSession
import com.viro.workcare.pairing.ScanProgress
import com.viro.workcare.pairing.ScanResult
import com.viro.workcare.pairing.SessionEvent
import com.viro.workcare.pairing.Wcp1
import com.viro.workcare.phone.PhoneFindings
import com.viro.workcare.phone.PhoneReader
import com.viro.workcare.phone.PhoneSnapshot
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

enum class Load { IDLE, LOADING, OK, FAILED }
enum class CleanPhase { IDLE, SCANNING, RESULTS, DELETING, DONE }
data class HistoryItem(val atMillis: Long, val title: String, val detail: String?)

/** One place that owns what the screens show. Data from the server is cached with its time, so the app can say "Last checked 4 minutes ago" instead of presenting old data as live. */
class AppVm(app: Application) : AndroidViewModel(app) {
    private val ctx: Context = app
    private val store = SecureStore(app)
    private val prefs = app.getSharedPreferences("wc", Context.MODE_PRIVATE)

    // ---------------------------------------------------------------------------------------------- account
    var onboarded by mutableStateOf(prefs.getBoolean("onboarded", false)); private set
    var server by mutableStateOf(prefs.getString("server", BuildConfig.DEFAULT_SERVER) ?: BuildConfig.DEFAULT_SERVER); private set
    var token by mutableStateOf<String?>(store.get("token")); private set
    var email by mutableStateOf(prefs.getString("email", null)); private set
    var themeMode by mutableStateOf(prefs.getString("theme", "system") ?: "system"); private set
    val signedIn get() = token != null
    val firstName: String get() = email?.substringBefore('@')?.replace(Regex("[._-]+"), " ")?.split(' ')?.firstOrNull()?.replaceFirstChar { it.uppercase() } ?: ""
    var loginError by mutableStateOf<String?>(null); var loginBusy by mutableStateOf(false); var needMfaCode by mutableStateOf(false)

    fun finishOnboarding() { onboarded = true; prefs.edit().putBoolean("onboarded", true).apply() }
    fun setTheme(mode: String) { themeMode = mode; prefs.edit().putString("theme", mode).apply() }
    fun setServer(url: String): String? { val u = url.trim().trimEnd('/'); if (!isAllowedServer(u)) return "Use an https address (a private-network address may use http)."; server = u; prefs.edit().putString("server", u).apply(); return null }
    private fun api() = ControlApi(server) { token }

    fun login(mail: String, password: String, code: String?) {
        loginBusy = true; loginError = null
        viewModelScope.launch {
            try {
                when (val r = api().login(mail.trim(), password, code)) {
                    is LoginResult.Ok -> { token = r.token; store.put("token", r.token); email = mail.trim(); prefs.edit().putString("email", email).apply(); needMfaCode = false; refresh() }
                    is LoginResult.MfaSetupRequired -> loginError = "Your organization requires two-step sign-in. Set it up in the WorkCare web console, then sign in here."
                    LoginResult.MfaRequired -> { needMfaCode = true; loginError = if (code.isNullOrBlank()) null else "That code is not right." }
                }
            } catch (e: ApiError) { loginError = if (e.status == 401) "That email and password do not match." else e.message }
            catch (e: Exception) { loginError = "Could not reach the server. Check your connection." }
            loginBusy = false
        }
    }
    fun logout() { token = null; store.put("token", null); devices = emptyList(); alerts = emptyList(); healthCache.clear(); prefs.edit().remove("devices_json").remove("devices_at").apply() }

    // ---------------------------------------------------------------------------------------------- this phone
    var phone by mutableStateOf<PhoneSnapshot?>(null); private set
    val phoneHealth: DeviceHealth? get() = phone?.let { PhoneFindings.health(it, "this-phone", if (plus) phoneDeep else null) }
    fun readPhone() { val before = phone; phone = PhoneReader.read(ctx); if (before == null) addHistory("Phone health checked", null) }

    // ---------------------------------------------------------------------------------------------- devices from the account
    var devices by mutableStateOf<List<DeviceSummary>>(emptyList()); private set
    var devicesAt by mutableLongStateOf(0L); private set
    var devicesLoad by mutableStateOf(Load.IDLE); private set
    var devicesError by mutableStateOf<String?>(null); private set
    var alerts by mutableStateOf<List<AlertItem>>(emptyList()); private set
    val healthCache = mutableStateMapOf<String, DeviceHealth>()
    val healthAt = mutableStateMapOf<String, Long>()
    val passport = mutableStateMapOf<String, List<PassportEvent>>()
    val compute = mutableStateMapOf<String, ComputeStatus>()

    fun refresh() {
        readPhone(); recordToday()
        if (!signedIn) return
        devicesLoad = Load.LOADING
        viewModelScope.launch {
            try {
                val raw = api().devicesRaw(); devices = parseDevices(raw); devicesAt = System.currentTimeMillis(); devicesError = null; devicesLoad = Load.OK
                prefs.edit().putString("devices_json", raw.toString()).putLong("devices_at", devicesAt).apply()
                alerts = parseAlerts(api().alertsRaw())
                devices.filter { it.status != Severity.HEALTHY }.take(4).forEach { loadDevice(it.id) }
            } catch (e: ApiError) { if (e.status == 401) { logout(); devicesError = "Your session ended. Sign in again." } else devicesError = e.message; devicesLoad = Load.FAILED }
            catch (e: Exception) { devicesError = "Could not reach WorkCare. Showing what was last known."; devicesLoad = Load.FAILED }
        }
    }
    fun loadDevice(id: String) {
        viewModelScope.launch {
            try {
                val raw = api().deviceRaw(id); healthCache[id] = parseDeviceHealth(raw); healthAt[id] = System.currentTimeMillis(); prefs.edit().putString("health_$id", raw.toString()).putLong("health_at_$id", healthAt[id]!!).apply()
            } catch (e: Exception) {
                if (healthCache[id] == null) prefs.getString("health_$id", null)?.let { try { healthCache[id] = parseDeviceHealth(JSONObject(it)); healthAt[id] = prefs.getLong("health_at_$id", 0) } catch (x: Exception) { } }
            }
        }
    }
    suspend fun loadDeviceNow(id: String) {
        try { val raw = api().deviceRaw(id); healthCache[id] = parseDeviceHealth(raw); healthAt[id] = System.currentTimeMillis() } catch (e: Exception) { /* keep what was cached; the screen says when it is old */ }
    }
    fun loadPassport(id: String) { viewModelScope.launch { try { passport[id] = api().passport(id) } catch (e: Exception) { } } }
    fun loadCompute(id: String) { viewModelScope.launch { try { compute[id] = api().compute(id) } catch (e: Exception) { } } }
    fun pauseCompute(id: String, minutes: Int, done: (String?) -> Unit) { viewModelScope.launch { try { compute[id] = api().pauseCompute(id, minutes); done(null) } catch (e: ApiError) { done(e.message) } catch (e: Exception) { done("Could not reach WorkCare.") } } }
    fun resumeCompute(id: String, done: (String?) -> Unit) { viewModelScope.launch { try { compute[id] = api().resumeCompute(id); done(null) } catch (e: ApiError) { done(e.message) } catch (e: Exception) { done("Could not reach WorkCare.") } } }
    fun runQuickScan(id: String, done: (String?) -> Unit) { viewModelScope.launch { try { api().runQuickScan(id); addHistory("Quick scan requested", devices.firstOrNull { it.id == id }?.name); done(null) } catch (e: ApiError) { done(e.message) } catch (e: Exception) { done("Could not reach WorkCare.") } } }
    fun runTest(id: String, test: String, done: (String?) -> Unit) { viewModelScope.launch { try { api().runTest(id, test); addHistory("Hardware test requested", devices.firstOrNull { it.id == id }?.name); done(null) } catch (e: ApiError) { done(e.message) } catch (e: Exception) { done("Could not reach WorkCare.") } } }

    fun freshnessOf(deviceId: String): Pair<Freshness, Long?> { val d = devices.firstOrNull { it.id == deviceId }; return (d?.freshness ?: Freshness.NEVER) to healthAt[deviceId] }

    // ---------------------------------------------------------------------------------------------- history (real local events only)
    val history = mutableStateListOf<HistoryItem>().also { l ->
        try { val a = JSONArray(prefs.getString("history", "[]")); for (i in 0 until a.length()) { val o = a.getJSONObject(i); l.add(HistoryItem(o.getLong("at"), o.getString("title"), o.optString("detail").ifEmpty { null })) } } catch (e: Exception) { }
    }
    fun addHistory(title: String, detail: String?) {
        history.add(0, HistoryItem(System.currentTimeMillis(), title, detail)); while (history.size > 40) history.removeAt(history.size - 1)
        prefs.edit().putString("history", JSONArray(history.map { JSONObject().put("at", it.atMillis).put("title", it.title).put("detail", it.detail ?: "") }).toString()).apply()
    }

    // ---------------------------------------------------------------------------------------------- check a computer (local session)
    var found by mutableStateOf<List<FoundComputer>>(emptyList()); private set
    var searching by mutableStateOf(false); private set
    var sessionError by mutableStateOf<String?>(null); var connecting by mutableStateOf(false); private set
    var session by mutableStateOf<LocalSession?>(null); private set
    var progress by mutableStateOf<ScanProgress?>(null); private set
    var result by mutableStateOf<ScanResult?>(null); private set
    private var pollJob: Job? = null

    /** True once a full search has finished without finding a computer: the screen then explains what to check instead of showing a dead end. */
    var searchedNothing by mutableStateOf(false); private set
    private var discoverJob: Job? = null

    /** Looks for QuickCheck on every network the phone is on. Safe to call repeatedly; a running search is reused. */
    fun discover(quiet: Boolean = false) {
        if (discoverJob?.isActive == true) return
        if (!quiet) { searching = true; searchedNothing = false }; sessionError = if (quiet) sessionError else null
        discoverJob = viewModelScope.launch {
            found = try { LanDiscovery.find(lastHost = prefs.getString("last_pc_host", null)) } catch (e: Exception) { emptyList() }
            searching = false; searchedNothing = found.isEmpty()
        }
    }

    /**
     * Connects with the typed code. Any computer found is tried in turn, so nobody picks an address: only the one whose
     * session the code belongs to accepts it. A wrong code is reported only after every candidate refused.
     */
    fun pair(code: String, onReady: () -> Unit) {
        if (connecting) return
        connecting = true; sessionError = null
        viewModelScope.launch {
            try {
                if (found.isEmpty()) { searching = true; discoverJob?.cancel(); found = try { LanDiscovery.find(lastHost = prefs.getString("last_pc_host", null)) } catch (e: Exception) { emptyList() }; searching = false; searchedNothing = found.isEmpty() }
                if (found.isEmpty()) { sessionError = null; return@launch }
                var failure: String? = null
                for (f in found) {
                    try { session = LocalSession.connect(f.host, f.port, code = code); prefs.edit().putString("last_pc_host", f.host).apply(); onReady(); return@launch }
                    catch (e: Wcp1.PairingException) { failure = e.message; if (e.message?.contains("not right") != true) break }
                    catch (e: Exception) { failure = e.message ?: "Could not connect." }
                }
                sessionError = failure ?: "Could not connect."
            } finally { connecting = false }
        }
    }
    fun connect(host: String, port: Int, code: String, onReady: () -> Unit) {
        connecting = true; sessionError = null
        viewModelScope.launch {
            try { session = LocalSession.connect(host, port, code = code); prefs.edit().putString("last_pc_host", host).apply(); onReady() }
            catch (e: Wcp1.PairingException) { sessionError = e.message }
            catch (e: Exception) { sessionError = e.message ?: "Could not connect." }
            connecting = false
        }
    }
    fun beginInspection() {
        val s = session ?: return; progress = null; result = null; sessionError = null
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            try {
                s.startScan(deep = plus)
                while (result == null) for (e in s.poll()) when (e) {
                    is SessionEvent.Progress -> progress = e.p
                    is SessionEvent.Result -> { result = e.r; addHistory("Computer check completed", e.r.deviceName) }
                    is SessionEvent.Failed -> { sessionError = e.message; return@launch }
                }
            } catch (e: Exception) { sessionError = "The connection to the computer was lost. Nothing was changed on it." }
            finally { s.close() }
        }
    }
    /** A workcare://pair link (opened from a QR scanner app or a message) carries the session, the public key, the expiry, the one-time secret and a network hint. */
    var pendingOffer by mutableStateOf<Wcp1.Offer?>(null)
    fun handleLink(url: String?) { if (url == null) return; try { pendingOffer = Wcp1.parseOffer(url) } catch (e: Wcp1.PairingException) { sessionError = e.message } }
    fun connectOffer(onReady: () -> Unit) {
        val o = pendingOffer ?: return; pendingOffer = null
        val hint = o.hints.firstOrNull { it.startsWith("lan:") }?.removePrefix("lan:")
        val host = hint?.substringBeforeLast(':'); val port = hint?.substringAfterLast(':')?.toIntOrNull()
        if (host == null || port == null) { sessionError = "This link has no network address. Use Quick Connect instead."; return }
        connecting = true; sessionError = null
        viewModelScope.launch { try { session = LocalSession.connect(host, port, offer = o); onReady() } catch (e: Wcp1.PairingException) { sessionError = e.message } catch (e: Exception) { sessionError = e.message ?: "Could not connect." }; connecting = false }
    }
    fun endSession() { pollJob?.cancel(); session = null; progress = null; result = null; sessionError = null; searchedNothing = false }
    /** Leaves the finished check on screen while the page closes, then forgets it. */
    fun clearResult() { result = null; progress = null }

    // ---------------------------------------------------------------------------------------------- phone hardware tests (TESTED evidence)
    val phoneTests = mutableStateMapOf<String, Boolean>()
    fun recordPhoneTest(id: String, ok: Boolean) { phoneTests[id] = ok; recordLabByEye(id, ok, if (ok) "passed" else "problem seen") }

    // ---------------------------------------------------------------------------------------------- pictures of gadgets
    var photoLookup by mutableStateOf(prefs.getBoolean("photo_lookup", true)); private set
    var photoVersion by androidx.compose.runtime.mutableIntStateOf(0); private set
    fun enablePhotoLookup(on: Boolean) { photoLookup = on; prefs.edit().putBoolean("photo_lookup", on).apply(); photoVersion++ }
    suspend fun devicePhoto(key: String, maker: String?, model: String?, phone: Boolean) = com.viro.workcare.photos.DevicePhotos.resolve(ctx, key, maker, model, phone, photoLookup)
    fun pickPhoto(key: String, uri: android.net.Uri) { viewModelScope.launch { if (com.viro.workcare.photos.DevicePhotos.savePicked(ctx, key, uri)) photoVersion++ } }
    fun removePhoto(key: String) { com.viro.workcare.photos.DevicePhotos.removeOwn(ctx, key); photoVersion++ }
    fun hasOwnPhoto(key: String) = com.viro.workcare.photos.DevicePhotos.hasOwn(ctx, key)

    // ---------------------------------------------------------------------------------------------- clean (permanent deletion of leftovers)
    var cleanPhase by mutableStateOf(CleanPhase.IDLE); private set
    var cleanReport by mutableStateOf<com.viro.workcare.clean.ScanReport?>(null); private set
    var cleanFilesSeen by mutableLongStateOf(0L); private set
    var cleanFolder by mutableStateOf<String?>(null); private set
    var cleanCats by mutableStateOf<Set<com.viro.workcare.clean.Cat>>(emptySet()); private set
    val cleanKeep = mutableStateListOf<String>()
    var cleanOverwrite by mutableStateOf(false)
    var cleanDeleteDone by androidx.compose.runtime.mutableIntStateOf(0); private set
    var cleanDeleteTotal by androidx.compose.runtime.mutableIntStateOf(0); private set
    var cleanResult by mutableStateOf<com.viro.workcare.clean.DeleteResult?>(null); private set
    var cleanFreeBefore by mutableStateOf<Long?>(null); private set
    var cleanFreeAfter by mutableStateOf<Long?>(null); private set
    @Volatile private var cleanCancel = false
    /** Debug builds only: limits Clean to one folder, so the scan and delete path can be tested on a real phone without touching real files. Release builds ignore this. */
    private var debugRoot: java.io.File? = null
    fun debugCleanRoot(i: android.content.Intent?) { if (BuildConfig.DEBUG) i?.getStringExtra("clean_root")?.let { debugRoot = if (it.isEmpty()) null else java.io.File(it) } }
    val cleanScope: String get() = debugRoot?.path ?: "Whole storage"
    private fun storageRoot() = debugRoot ?: android.os.Environment.getExternalStorageDirectory()
    private fun freeNow() = try { android.os.StatFs(android.os.Environment.getDataDirectory().path).availableBytes } catch (e: Exception) { null }
    var lastCleanBytes by mutableLongStateOf(prefs.getLong("clean_last_bytes", -1L)); private set
    fun scanClean() { viewModelScope.launch { doScanClean() } }
    suspend fun doScanClean() {
        cleanPhase = CleanPhase.SCANNING; cleanCancel = false; cleanFilesSeen = 0; cleanReport = null; cleanKeep.clear()
        val r = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { com.viro.workcare.clean.Cleaner.scan(storageRoot(), 90_000, { n, f -> cleanFilesSeen = n; cleanFolder = f }, { cleanCancel }) }
        cleanReport = r; cleanCats = com.viro.workcare.clean.Cat.entries.filter { it.selected && r.of(it).isNotEmpty() }.toSet(); cleanPhase = CleanPhase.RESULTS
        if (debugRoot == null) { lastCleanBytes = r.items.filter { it.cat.selected }.sumOf { it.bytes }; prefs.edit().putLong("clean_last_bytes", lastCleanBytes).apply() }
        addHistory("Storage scan", "${r.items.size} leftovers found")
    }
    fun cancelClean() { cleanCancel = true }
    fun toggleCat(c: com.viro.workcare.clean.Cat) { if (c in cleanCats) cleanCats = cleanCats - c else { cleanCats = cleanCats + c; cleanReport?.of(c)?.forEach { cleanKeep.remove(it.path) } } }
    /** Ticking one item inside a group that is off turns the group on but keeps every other item in it out. */
    fun toggleItem(path: String, c: com.viro.workcare.clean.Cat) {
        if (c !in cleanCats) { cleanCats = cleanCats + c; cleanReport?.of(c)?.forEach { if (it.path != path && it.path !in cleanKeep) cleanKeep.add(it.path) }; cleanKeep.remove(path) }
        else if (path in cleanKeep) cleanKeep.remove(path) else cleanKeep.add(path)
    }
    fun cleanSelectedItems(): List<com.viro.workcare.clean.Item> = cleanReport?.items?.filter { it.cat in cleanCats && it.path !in cleanKeep } ?: emptyList()
    fun deleteClean() {
        val items = cleanSelectedItems(); if (items.isEmpty()) return
        cleanPhase = CleanPhase.DELETING; cleanDeleteDone = 0; cleanDeleteTotal = items.size; cleanFreeBefore = freeNow()
        viewModelScope.launch {
            val res = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { com.viro.workcare.clean.Cleaner.delete(storageRoot(), items, cleanOverwrite) { d, _ -> cleanDeleteDone = d } }
            cleanResult = res; cleanFreeAfter = freeNow(); cleanPhase = CleanPhase.DONE
            addHistory("Deleted leftovers", "${res.deleted} items, ${res.freedBytes / 1048576} MB"); readPhone(); recordToday()
            if (debugRoot == null) { lastCleanBytes = maxOf(0L, lastCleanBytes - res.freedBytes); prefs.edit().putLong("clean_last_bytes", lastCleanBytes).apply() }
        }
    }
    fun resetClean() { cleanPhase = CleanPhase.IDLE; cleanReport = null; cleanResult = null }

    // ---------------------------------------------------------------------------------------------- plan and deep audit
    /** Testing switch, only honoured in debug builds. Real purchases are not connected yet. */
    var plusTest by mutableStateOf(BuildConfig.DEBUG && prefs.getBoolean("plus_test", false)); private set
    /** WorkCare Plus: included with a signed-in WorkCare organization account, or switched on for testing in a debug build. */
    val plus: Boolean get() = signedIn || plusTest
    val plusSource: String? get() = if (signedIn) "Included with your WorkCare organization account" else if (plusTest) "Testing unlock (debug build)" else null
    fun enablePlusTest(on: Boolean) { if (!BuildConfig.DEBUG) return; plusTest = on; prefs.edit().putBoolean("plus_test", on).putBoolean("plus_active", plus).apply() }
    var phoneDeep by mutableStateOf<com.viro.workcare.phone.PhoneDeep?>(null); private set
    var deepRunning by mutableStateOf(false); private set
    fun runPhoneDeep() { if (!plus || deepRunning) return; viewModelScope.launch { doPhoneDeep() } }
    suspend fun doPhoneDeep() {
        deepRunning = true
        val d = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { com.viro.workcare.phone.PhoneDeepReader.read(ctx) }
        phoneDeep = d; deepRunning = false
        addHistory("Deep audit of this phone", com.viro.workcare.phone.PhoneDeepFindings.evaluate(d).let { l -> "${l.size} checks · ${l.count { it.severity != Severity.HEALTHY }} need a look" })
    }

    // ---------------------------------------------------------------------------------------------- daily readings
    var daily by mutableStateOf<List<com.viro.workcare.daily.DaySnapshot>>(emptyList()); private set
    var dailyOn by mutableStateOf(com.viro.workcare.daily.DailyScheduler.enabled(app)); private set
    fun setDaily(on: Boolean) { com.viro.workcare.daily.DailyScheduler.setEnabled(ctx, on); if (on) com.viro.workcare.daily.DailyScheduler.channel(ctx); dailyOn = on }
    /** Stores today's reading of this phone (the daily trend history). Cheap: one small file write. */
    fun recordToday() {
        val p = phone ?: return
        val f = PhoneFindings.evaluate(p) + (if (plus) phoneDeep?.let { com.viro.workcare.phone.PhoneDeepFindings.evaluate(it) }.orEmpty() else emptyList())
        com.viro.workcare.daily.DailyStore.record(ctx, p, f); daily = com.viro.workcare.daily.DailyStore.load(ctx)
        prefs.edit().putBoolean("plus_active", plus).apply()
    }

    // ---------------------------------------------------------------------------------------------- smart scan: phone health, security, storage in one run
    data class SmartStage(val id: String, val label: String, val state: String, val detail: String?)
    var smartStages by mutableStateOf<List<SmartStage>>(emptyList()); private set
    var smartRunning by mutableStateOf(false); private set
    var smartDone by mutableStateOf(false); private set
    private fun smartSet(id: String, state: String, detail: String? = null) { smartStages = smartStages.map { if (it.id == id) it.copy(state = state, detail = detail) else it } }
    fun runSmart() {
        if (smartRunning) return
        smartRunning = true; smartDone = false
        smartStages = listOf(SmartStage("health", "Phone health", "waiting", null), SmartStage("security", "Security", "waiting", null), SmartStage("storage", "Storage", "waiting", null))
        viewModelScope.launch {
            smartSet("health", "running"); readPhone(); recordToday(); smartSet("health", "done", (phoneHealth?.findings?.count { it.severity != Severity.HEALTHY } ?: 0).let { if (it == 0) "No problems" else "$it to fix" })
            if (plus) { smartSet("security", "running"); doPhoneDeep(); smartSet("security", "done", phoneDeep?.let { d -> com.viro.workcare.phone.PhoneDeepFindings.evaluate(d).count { it.severity != Severity.HEALTHY } }?.let { if (it == 0) "Nothing unusual" else "$it to look at" }) }
            else smartSet("security", "skipped", "Deeper checks are part of Plus")
            if (com.viro.workcare.ui.hasAllFiles()) { smartSet("storage", "running"); doScanClean(); smartSet("storage", "done", cleanReport?.let { r -> bytesLabel(r.items.filter { it.cat.selected }.sumOf { it.bytes }) + " of leftovers" }) }
            else smartSet("storage", "skipped", "Needs file access (Clean tab)")
            smartRunning = false; smartDone = true
        }
    }
    fun finishSmart() { smartDone = false; smartStages = emptyList() }
    private fun bytesLabel(b: Long) = com.viro.workcare.ui.bytesText(b)

    // ---------------------------------------------------------------------------------------------- gadgets: reports, the lab, and the deal check
    var gadgets by mutableStateOf<List<com.viro.workcare.gadget.GadgetReport>>(com.viro.workcare.gadget.GadgetStore.all(app)); private set
    var lab by mutableStateOf<Map<String, com.viro.workcare.gadget.LabResult>>(com.viro.workcare.gadget.LabStore.load(app)); private set
    var phoneReport by mutableStateOf<com.viro.workcare.gadget.GadgetReport?>(null); private set
    fun boughtYear(id: String): Int? = prefs.getInt("bought_${id}", 0).takeIf { it > 0 }
    fun setBoughtYear(id: String, year: Int?) { prefs.edit().apply { if (year == null) remove("bought_${id}") else putInt("bought_${id}", year) }.apply(); if (id == com.viro.workcare.ui.R.THIS_PHONE) rebuildPhoneReport() else gadgets.firstOrNull { it.id == id }?.let { /* PC reports are rebuilt from the saved scan next time it is opened */ } }
    /** Builds this phone's report from live readings and the Lab results, and saves it to "My gadgets". */
    fun rebuildPhoneReport() {
        val p = phone ?: return
        val findings = PhoneFindings.evaluate(p) + (if (plus) phoneDeep?.let { com.viro.workcare.phone.PhoneDeepFindings.evaluate(it) }.orEmpty() else emptyList())
        val r = com.viro.workcare.gadget.PhoneGadget.read(ctx, p, findings, lab, boughtYear(com.viro.workcare.ui.R.THIS_PHONE)); phoneReport = r
        com.viro.workcare.gadget.GadgetStore.save(ctx, r.copy(id = com.viro.workcare.ui.R.THIS_PHONE)); gadgets = com.viro.workcare.gadget.GadgetStore.all(ctx)
    }
    fun reportFor(id: String): com.viro.workcare.gadget.GadgetReport? = if (id == com.viro.workcare.ui.R.THIS_PHONE) (phoneReport ?: run { rebuildPhoneReport(); phoneReport }) else gadgets.firstOrNull { it.id == id }
    fun removeGadget(id: String) { com.viro.workcare.gadget.GadgetStore.remove(ctx, id); gadgets = com.viro.workcare.gadget.GadgetStore.all(ctx) }
    fun saveScanAsGadget(r: ScanResult): com.viro.workcare.gadget.GadgetReport { val g = com.viro.workcare.gadget.PcGadget.fromScan(r, boughtYear = boughtYear("pc-${r.deviceName}")); com.viro.workcare.gadget.GadgetStore.save(ctx, g); gadgets = com.viro.workcare.gadget.GadgetStore.all(ctx); return g }

    var labRunning by mutableStateOf<com.viro.workcare.gadget.LabTest?>(null); private set
    var labProgress by mutableStateOf(0f); private set
    var labStep by mutableStateOf(""); private set
    var labOutcome by mutableStateOf<com.viro.workcare.gadget.LabOutcome?>(null); private set
    fun runLab(t: com.viro.workcare.gadget.LabTest) {
        if (labRunning != null) return
        labRunning = t; labProgress = 0f; labStep = "Starting"; labOutcome = null
        viewModelScope.launch {
            val o = try { com.viro.workcare.gadget.Lab.run(ctx, t) { f, s -> labProgress = f; labStep = s } } catch (e: Exception) { com.viro.workcare.gadget.LabOutcome(null, "Could not run", listOf(e.message ?: "The test failed to start.")) }
            val r = com.viro.workcare.gadget.LabResult(t.id, o.ok, o.value, System.currentTimeMillis()); com.viro.workcare.gadget.LabStore.save(ctx, r); lab = com.viro.workcare.gadget.LabStore.load(ctx)
            labOutcome = o; labRunning = null; addHistory("Lab: ${t.title}", o.value); rebuildPhoneReport()
        }
    }
    fun clearLabOutcome() { labOutcome = null }
    /** Hardware tests the person judges by eye (screen, touch, vibration, flash, speaker, charging) also land in the Lab. */
    fun recordLabByEye(id: String, ok: Boolean, value: String) { val r = com.viro.workcare.gadget.LabResult(id, ok, value, System.currentTimeMillis()); com.viro.workcare.gadget.LabStore.save(ctx, r); lab = com.viro.workcare.gadget.LabStore.load(ctx); rebuildPhoneReport() }

    // Must stay last: it uses properties declared above, and Kotlin initialises them in order.
    init {
        // Show what we last knew immediately, honestly dated, then refresh.
        prefs.getString("devices_json", null)?.let { try { devices = parseDevices(JSONObject(it)); devicesAt = prefs.getLong("devices_at", 0) } catch (e: Exception) { } }
        readPhone(); recordToday(); rebuildPhoneReport()
        if (signedIn) refresh()
    }
}
