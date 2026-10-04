package com.viro.workcare.pairing

import com.viro.workcare.data.ContractException
import com.viro.workcare.data.Finding
import com.viro.workcare.data.parseFinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.net.URL

/** A QuickCheck (or Desktop) that answered the discovery broadcast. Only its address, port and session id are known before pairing: no name, no hardware. */
data class FoundComputer(val host: String, val port: Int, val sessionIdHex: String)

data class ScanStage(val id: String, val label: String, val state: String, val detail: String?)
data class ScanProgress(val scanId: String, val stages: List<ScanStage>, val completed: Int, val total: Int, val finished: Boolean, val deviceName: String? = null, val deviceModel: String? = null)
data class ScanResult(val scanId: String, val deviceName: String, val deviceModel: String?, val passed: Int, val attention: Int, val critical: Int, val findings: List<Finding>, val notMeasured: List<String>, val disclaimer: String, val depth: String = "essential", val deepNotRun: List<com.viro.workcare.phone.DeepCheck> = emptyList(), val facts: List<com.viro.workcare.gadget.Fact> = emptyList())

fun parseScanProgress(o: JSONObject): ScanProgress {
    val st = o.getJSONArray("stages")
    return ScanProgress(o.optString("scanId"), (0 until st.length()).map { val s = st.getJSONObject(it); ScanStage(s.getString("id"), s.getString("label"), s.getString("state"), if (s.isNull("detail")) null else s.optString("detail")) }, o.getInt("completedStages"), o.getInt("totalStages"), o.optBoolean("finished"), o.optJSONObject("device")?.optString("name")?.ifEmpty { null }, o.optJSONObject("device")?.let { if (it.isNull("model")) null else it.optString("model").ifEmpty { null } })
}
fun parseScanResult(o: JSONObject): ScanResult {
    val d = o.getJSONObject("device"); val f = o.getJSONArray("findings"); val nm = o.optJSONArray("notMeasured") ?: JSONArray(); val nr = o.optJSONArray("deepNotRun") ?: JSONArray(); val fa = o.optJSONArray("facts") ?: JSONArray()
    return ScanResult(o.optString("scanId"), d.optString("name"), if (d.isNull("model")) null else d.optString("model"), o.getInt("passed"), o.getInt("attention"), o.getInt("critical"), (0 until f.length()).map { parseFinding(f.getJSONObject(it)) }, (0 until nm.length()).map { nm.getString(it) }, o.optString("disclaimer"),
        o.optString("depth", "essential"), (0 until nr.length()).map { val c = nr.getJSONObject(it); com.viro.workcare.phone.DeepCheck(c.optString("id"), c.optString("title"), c.optString("why")) },
        (0 until fa.length()).map { val f = fa.getJSONObject(it); com.viro.workcare.gadget.Fact(f.optString("group"), f.optString("label"), f.optString("value"), com.viro.workcare.data.EvidenceType.parse(if (f.isNull("evidenceType")) null else f.optString("evidenceType"))) })
}

sealed class SessionEvent { class Progress(val p: ScanProgress) : SessionEvent(); class Result(val r: ScanResult) : SessionEvent(); class Failed(val message: String) : SessionEvent() }

object LanDiscovery {
    const val PORT = 47820
    const val HTTP_PORT = 47821

    /**
     * Finds QuickCheck on its own, so nobody has to know an address. Four independent routes run together and the first answers win:
     *  1. a UDP broadcast on every local network the phone is on (Wi-Fi, its own hotspot, a USB tether);
     *  2. a quick sweep of the phone's own subnet(s) for the WorkCare info page, which works on networks that drop broadcasts;
     *  3. the address that worked last time;
     *  4. this device itself and the emulator host (a USB-forwarded port during development).
     * Only the WorkCare info page is read; nothing else about the network is touched.
     */
    suspend fun find(timeoutMs: Int = 4500, lastHost: String? = null): List<FoundComputer> = withContext(Dispatchers.IO) {
        val found = java.util.concurrent.ConcurrentHashMap<String, FoundComputer>()
        val started = System.currentTimeMillis()
        val ifaces = try { NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback } } catch (e: Exception) { emptyList() }
        val mine = ifaces.flatMap { it.interfaceAddresses }.filter { it.address is java.net.Inet4Address && isPrivateHost(it.address.hostAddress ?: "") }
        val myHosts = mine.mapNotNull { it.address.hostAddress }.toSet()
        coroutineScope {
            val jobs = ArrayList<Job>()
            jobs += launch { broadcast(ifaces, found, timeoutMs) }
            val candidates = LinkedHashSet<String>()
            lastHost?.let { candidates.add(it) }
            candidates.add("127.0.0.1"); candidates.add("10.0.2.2")
            jobs += launch { candidates.forEach { h -> probe(h)?.let { found[h] = it } } }
            // Sweep each /24 the phone is on (a wider network is narrowed to the phone's own /24, the common case for homes and hotspots).
            val hosts = LinkedHashSet<String>()
            mine.forEach { a ->
                val parts = (a.address.hostAddress ?: "").split('.'); if (parts.size == 4) for (i in 1..254) { val h = "${parts[0]}.${parts[1]}.${parts[2]}.$i"; if (h !in myHosts) hosts.add(h) }
            }
            val gate = Semaphore(48)
            hosts.forEach { h -> jobs += launch { gate.withPermit { if (found.isEmpty() || System.currentTimeMillis() - started < 1500) probe(h)?.let { found[h] = it } } } }
            // Stop early once something answered and the others had a fair moment; otherwise wait for the full time.
            while (jobs.any { it.isActive } && System.currentTimeMillis() - started < timeoutMs) {
                delay(80)
                if (found.isNotEmpty() && System.currentTimeMillis() - started > 1400) break
            }
            jobs.forEach { it.cancel() }
        }
        found.values.toList()
    }

    private fun broadcast(ifaces: List<NetworkInterface>, found: MutableMap<String, FoundComputer>, timeoutMs: Int) {
        try {
            DatagramSocket().use { s ->
                s.broadcast = true; s.soTimeout = 300
                val probe = "WCP1?".toByteArray()
                val targets = ifaces.flatMap { it.interfaceAddresses }.mapNotNull { it.broadcast }.distinct()
                val end = System.currentTimeMillis() + timeoutMs; var lastSend = 0L; val buf = ByteArray(512)
                while (System.currentTimeMillis() < end) {
                    if (System.currentTimeMillis() - lastSend > 700) { targets.forEach { t -> try { s.send(DatagramPacket(probe, probe.size, t, PORT)) } catch (e: Exception) { } }; lastSend = System.currentTimeMillis() }
                    try {
                        val p = DatagramPacket(buf, buf.size); s.receive(p)
                        val j = JSONObject(String(p.data, 0, p.length)); val host = p.address.hostAddress ?: continue
                        if (j.optString("protocol") == "WCP1" && isPrivateHost(host)) found[host] = FoundComputer(host, j.getInt("port"), j.optString("session"))
                    } catch (e: SocketTimeoutException) { } catch (e: Exception) { }
                }
            }
        } catch (e: Exception) { }
    }

    /** Asks one address for the WorkCare info page. Short timeouts: a quiet address costs a third of a second, not a hang. */
    private fun probe(host: String, port: Int = HTTP_PORT): FoundComputer? {
        val c = URL("http://$host:$port/wcp1/info").openConnection() as HttpURLConnection
        return try {
            c.connectTimeout = 350; c.readTimeout = 900
            if (c.responseCode != 200) null else { val j = JSONObject(c.inputStream.bufferedReader().readText()); if (j.optString("protocol") == "WCP1") FoundComputer(host, port, j.optString("session")) else null }
        } catch (e: Exception) { null } finally { c.disconnect() }
    }
    private fun isPrivateHost(h: String) = com.viro.workcare.data.isPrivateHost(h)
}

/** An encrypted inspection session with one PC. HTTP is only the carrier: every body after the hello is an AES-GCM frame, so any transport that can move bytes works. */
class LocalSession private constructor(private val base: String, private val channel: Wcp1.Channel, val sas: String) {
    private var since = 0L
    private fun post(path: String, body: JSONObject): JSONObject {
        val c = URL(base + path).openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"; c.connectTimeout = 5000; c.readTimeout = 15000; c.doOutput = true; c.setRequestProperty("content-type", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray()) }
            val text = (if (c.responseCode in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""
            val j = if (text.isBlank()) JSONObject() else JSONObject(text)
            if (c.responseCode !in 200..299) throw Wcp1.PairingException(when (j.optString("error")) { "expired" -> "The pairing code has expired. Start again on the computer."; "locked" -> "Too many wrong codes. Start a new session on the computer."; "used" -> "This session is already in use."; "bad_proof" -> "That code is not right."; else -> "The computer refused the connection." })
            return j
        } finally { c.disconnect() }
    }
    private suspend fun request(msg: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val resp = post("/wcp1/msg", JSONObject().put("frame", Wcp1.b64u(channel.send(msg.toString().toByteArray()))))
        JSONObject(String(channel.receive(Wcp1.unb64u(resp.getString("frame")))))
    }

    /** [deep] asks the computer to run the deep audit as well (WorkCare Plus). A computer that does not know the word simply runs the essentials. */
    suspend fun startScan(deep: Boolean = false): String = request(JSONObject().put("type", "start_scan").apply { if (deep) put("depth", "deep") }).getString("scanId")
    /** Long-polls for new events. Returns when something happened or after a few seconds. */
    suspend fun poll(): List<SessionEvent> {
        val r = request(JSONObject().put("type", "poll").put("since", since).put("waitMs", 6000))
        since = r.getLong("next"); val out = ArrayList<SessionEvent>(); val ev = r.getJSONArray("events")
        for (i in 0 until ev.length()) {
            val e = ev.getJSONObject(i)
            when (e.getString("kind")) { "progress" -> out.add(SessionEvent.Progress(parseScanProgress(e.getJSONObject("payload")))); "result" -> out.add(SessionEvent.Result(parseScanResult(e.getJSONObject("payload")))); "error" -> out.add(SessionEvent.Failed(e.optString("message"))) }
        }
        return out
    }
    suspend fun close() { try { request(JSONObject().put("type", "close")) } catch (e: Exception) { } }

    companion object {
        /** Pairs using a typed session code (nine digits) or a full offer parsed from a QR / link. */
        suspend fun connect(host: String, port: Int, code: String? = null, offer: Wcp1.Offer? = null): LocalSession = withContext(Dispatchers.IO) {
            if (!com.viro.workcare.data.isPrivateHost(host)) throw Wcp1.PairingException("Local pairing is only allowed on a private network.")
            val base = "http://$host:$port"
            val o = offer ?: run {
                val c = URL("$base/wcp1/info").openConnection() as HttpURLConnection
                val info = try { c.connectTimeout = 4000; c.readTimeout = 4000; JSONObject(c.inputStream.bufferedReader().readText()) } catch (e: Exception) { throw Wcp1.PairingException("Could not reach the computer.") } finally { c.disconnect() }
                if (info.optString("protocol") != "WCP1") throw ContractException("This computer speaks a different WorkCare version.")
                Wcp1.Offer(Wcp1.unb64u(info.getString("session")), Wcp1.unb64u(info.getString("pcPub")), info.getLong("expiresAt"), Wcp1.secretFromCode(code ?: throw Wcp1.PairingException("Enter the code shown on the computer.")), emptyList())
            }
            if (System.currentTimeMillis() / 1000 >= o.expiresAt) throw Wcp1.PairingException("The pairing code has expired. Start again on the computer.")
            val hs = Wcp1.Handshake(o)
            val tmp = object { fun post(body: JSONObject): JSONObject {
                val c = URL("$base/wcp1/hello").openConnection() as HttpURLConnection
                try { c.requestMethod = "POST"; c.connectTimeout = 5000; c.readTimeout = 8000; c.doOutput = true; c.setRequestProperty("content-type", "application/json"); c.outputStream.use { it.write(body.toString().toByteArray()) }
                    val text = (if (c.responseCode in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""; val j = if (text.isBlank()) JSONObject() else JSONObject(text)
                    if (c.responseCode !in 200..299) throw Wcp1.PairingException(when (j.optString("error")) { "expired" -> "The pairing code has expired. Start again on the computer."; "locked" -> "Too many wrong codes. Start a new session on the computer."; "used" -> "This session is already in use."; "bad_proof" -> "That code is not right."; else -> "The computer refused the connection." })
                    return j } finally { c.disconnect() } } }
            val r = tmp.post(JSONObject().put("phonePub", Wcp1.b64u(hs.hello.phonePub)).put("nonceP", Wcp1.b64u(hs.hello.nonceP)).put("proof", Wcp1.b64u(hs.hello.proof)))
            val keys = hs.finish(Wcp1.Accept(Wcp1.unb64u(r.getString("nonceC")), Wcp1.unb64u(r.getString("proof"))))
            LocalSession(base, Wcp1.Channel(keys, o.sessionId), keys.sas)
        }
    }
}
