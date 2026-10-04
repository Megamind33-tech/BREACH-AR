package com.viro.workcare.gadget

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import kotlin.coroutines.resume
import kotlin.math.abs

/** What the Lab can test. [needs] is the Android permission asked for at the moment the test starts, never before. */
enum class LabTest(val id: String, val title: String, val what: String, val needs: String? = null) {
    CHARGER("charger", "Charger and cable", "Measures the current the phone really draws while charging. A weak cable or charger shows as a low number.", null),
    STORAGE("storage_speed", "Storage speed", "Writes and reads 64 MB on the phone's storage and reports megabytes per second. Very slow storage is a sign of wear or a poor-quality chip.", null),
    CPU("cpu", "Processor", "Runs a fixed workload on one core and on all cores. The score means little alone; it shows whether this phone got slower since the last run.", null),
    SENSORS("sensors", "Sensors", "Checks that every sensor Android lists actually reports readings.", null),
    CAMERA("camera", "Cameras", "Opens each camera to check the hardware answers. It does not take pictures.", android.Manifest.permission.CAMERA),
    MIC("mic", "Microphone", "Listens for 3 seconds and shows the loudest level. Say something while it listens.", android.Manifest.permission.RECORD_AUDIO),
    WIFI("wifi", "Wi-Fi link", "Shows the Wi-Fi speed and signal this phone has right now.", null),
}

class LabOutcome(val ok: Boolean?, val value: String, val detail: List<String>)

object LabStore {
    private fun file(ctx: Context) = File(ctx.filesDir, "lab.json")
    fun load(ctx: Context): Map<String, LabResult> = try {
        val o = JSONObject(file(ctx).takeIf { it.exists() }?.readText() ?: "{}"); o.keys().asSequence().associateWith { k -> val r = o.getJSONObject(k); LabResult(k, if (r.isNull("ok")) null else r.getBoolean("ok"), r.getString("value"), r.getLong("at")) }
    } catch (e: Exception) { emptyMap() }
    fun save(ctx: Context, r: LabResult) { val all = load(ctx).toMutableMap(); all[r.id] = r; val o = JSONObject(); all.forEach { (k, v) -> o.put(k, JSONObject().put("ok", v.ok ?: JSONObject.NULL).put("value", v.value).put("at", v.at)) }; try { file(ctx).writeText(o.toString()) } catch (e: Exception) { } }
    fun history(ctx: Context, id: String): List<Pair<Long, Double>> = try { JSONArray(File(ctx.filesDir, "lab_$id.json").takeIf { it.exists() }?.readText() ?: "[]").let { a -> (0 until a.length()).map { a.getJSONObject(it).let { o -> o.getLong("at") to o.getDouble("v") } } } } catch (e: Exception) { emptyList() }
    fun addHistory(ctx: Context, id: String, v: Double) { val h = (history(ctx, id) + (System.currentTimeMillis() to v)).takeLast(30); try { File(ctx.filesDir, "lab_$id.json").writeText(JSONArray(h.map { JSONObject().put("at", it.first).put("v", it.second) }).toString()) } catch (e: Exception) { } }
}

object Lab {
    suspend fun run(ctx: Context, t: LabTest, onProgress: (Float, String) -> Unit): LabOutcome = withContext(Dispatchers.Default) {
        when (t) {
            LabTest.CHARGER -> charger(ctx, onProgress); LabTest.STORAGE -> storage(ctx, onProgress); LabTest.CPU -> cpu(ctx, onProgress)
            LabTest.SENSORS -> sensors(ctx, onProgress); LabTest.CAMERA -> camera(ctx, onProgress); LabTest.MIC -> mic(ctx, onProgress); LabTest.WIFI -> wifi(ctx)
        }
    }

    private suspend fun charger(ctx: Context, p: (Float, String) -> Unit): LabOutcome {
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        fun status() = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val plugged = (status()?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        if (!plugged) return LabOutcome(null, "Not charging", listOf("Plug the phone into the charger and cable you want to test, then run this again."))
        val samples = ArrayList<Long>(); val volts = ArrayList<Int>()
        for (i in 1..8) { p(i / 8f, "Measuring ${i}s"); val c = bm.getLongProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW); if (c != Long.MIN_VALUE && c != 0L) samples.add(abs(c)); volts.add(status()?.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0) ?: 0); delay(1000) }
        if (samples.isEmpty()) return LabOutcome(null, "Not available", listOf("This phone does not report charging current to apps."))
        // Android reports microamps on most phones and milliamps on a few; a value under 20000 can only be milliamps.
        val med = samples.sorted()[samples.size / 2]; val ma = if (med < 20_000) med.toDouble() else med / 1000.0
        val v = volts.filter { it > 0 }.average().takeIf { !it.isNaN() }?.div(1000.0); val w = v?.let { ma / 1000.0 * it }
        val pct = status()?.let { it.getIntExtra(BatteryManager.EXTRA_LEVEL, 0) * 100 / it.getIntExtra(BatteryManager.EXTRA_SCALE, 100) } ?: 0
        val ok: Boolean? = if (pct >= 90) null else ma >= 500
        val lines = ArrayList<String>(); lines.add("Charging at ${ma.toInt()} mA" + (w?.let { String.format(java.util.Locale.US, " (about %.1f W)", it) } ?: "") + " at $pct% battery.")
        lines.add(if (pct >= 90) "The battery is nearly full, so charging current is naturally low. Test again below 80% for a fair reading." else if (ma >= 1500) "That is a healthy fast-charging rate." else if (ma >= 500) "That is a normal slow charge. A different cable or charger might be faster." else "That is very slow. Try another cable first; if it stays slow, the charger or the phone's charging port may be worn.")
        LabStore.addHistory(ctx, "charger", ma)
        return LabOutcome(ok, "${ma.toInt()} mA", lines)
    }

    private suspend fun storage(ctx: Context, p: (Float, String) -> Unit): LabOutcome {
        val f = File(ctx.cacheDir, "wc_speed.bin"); val size = 64 * 1024 * 1024; val chunk = ByteArray(1024 * 1024).also { java.util.Random().nextBytes(it) }
        return try {
            p(.05f, "Writing"); val w0 = System.nanoTime(); RandomAccessFile(f, "rw").use { r -> repeat(64) { i -> r.write(chunk); if (i % 8 == 0) p(.05f + .45f * i / 64, "Writing") }; r.fd.sync() }; val wMs = (System.nanoTime() - w0) / 1e6
            p(.55f, "Reading"); val r0 = System.nanoTime(); f.inputStream().use { s -> val b = ByteArray(1024 * 1024); var n = 0L; while (true) { val k = s.read(b); if (k < 0) break; n += k } }; val rMs = (System.nanoTime() - r0) / 1e6
            val w = size / 1048576.0 / (wMs / 1000.0); val r = size / 1048576.0 / (rMs / 1000.0)
            LabStore.addHistory(ctx, "storage_speed", w)
            val ok = w >= 20
            LabOutcome(ok, "write ${w.toInt()} MB/s", listOf("Write ${w.toInt()} MB/s, read ${r.toInt()} MB/s (read can be faster than real because Android caches the file).", if (ok) "That is in the normal range for phone storage." else "Write speed under 20 MB/s is slow. It can mean a nearly full or worn storage chip."))
        } finally { f.delete() }
    }

    private suspend fun cpu(ctx: Context, p: (Float, String) -> Unit): LabOutcome {
        fun work(): Double { val d = ByteArray(1 shl 20) { (it * 31).toByte() }; val md = MessageDigest.getInstance("SHA-256"); val t0 = System.nanoTime(); var h = 0L; repeat(24) { md.update(d); h += md.digest()[0] }; if (h == 42L) println(h); return 24.0 / ((System.nanoTime() - t0) / 1e9) }
        p(.1f, "One core"); val single = work(); p(.5f, "All cores"); val n = Runtime.getRuntime().availableProcessors()
        val multi = withContext(Dispatchers.Default) { val res = DoubleArray(n); val ts = (0 until n).map { i -> Thread { res[i] = work() }.also { it.start() } }; ts.forEach { it.join() }; res.sum() }
        val score = single.toInt(); val prev = LabStore.history(ctx, "cpu").lastOrNull()?.second; LabStore.addHistory(ctx, "cpu", single)
        val lines = arrayListOf("One core: ${single.toInt()} points. All $n cores together: ${multi.toInt()} points.")
        lines.add(if (prev == null) "This is the first run, so there is nothing to compare with yet. Run it again after a few weeks to see if the phone slowed down." else { val d = (single - prev) / prev * 100; "Compared with the last run: ${if (d >= 0) "+" else ""}${d.toInt()}%." + if (d < -25) " That is a large drop; heat or a busy phone can cause it, so test again when idle." else "" })
        return LabOutcome(null, "$score pts", lines)
    }

    private suspend fun sensors(ctx: Context, p: (Float, String) -> Unit): LabOutcome {
        val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val wanted = listOf(Sensor.TYPE_ACCELEROMETER to "Accelerometer", Sensor.TYPE_GYROSCOPE to "Gyroscope", Sensor.TYPE_MAGNETIC_FIELD to "Compass", Sensor.TYPE_PROXIMITY to "Proximity", Sensor.TYPE_LIGHT to "Light", Sensor.TYPE_PRESSURE to "Barometer").mapNotNull { (t, n) -> sm.getDefaultSensor(t)?.let { Triple(t, n, it) } }
        if (wanted.isEmpty()) return LabOutcome(null, "None listed", listOf("This phone lists none of the common sensors."))
        val got = java.util.concurrent.ConcurrentHashMap<Int, FloatArray>()
        val l = object : SensorEventListener { override fun onSensorChanged(e: SensorEvent) { got[e.sensor.type] = e.values.clone() }; override fun onAccuracyChanged(s: Sensor?, a: Int) {} }
        wanted.forEach { sm.registerListener(l, it.third, SensorManager.SENSOR_DELAY_NORMAL) }
        for (i in 1..6) { p(i / 6f, "Listening"); delay(500) }
        sm.unregisterListener(l)
        val lines = wanted.map { (t, n, _) -> val v = got[t]; "$n: " + (v?.take(3)?.joinToString(", ") { String.format(java.util.Locale.US, "%.2f", it) } ?: "no reading") }
        val ok = wanted.count { got.containsKey(it.first) }
        return LabOutcome(ok == wanted.size, "$ok of ${wanted.size} respond", lines + "Move the phone while this runs: the accelerometer and gyroscope only report changes.")
    }

    @SuppressLint("MissingPermission")
    private suspend fun camera(ctx: Context, p: (Float, String) -> Unit): LabOutcome {
        val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager; val ids = cm.cameraIdList; if (ids.isEmpty()) return LabOutcome(null, "No camera", listOf("Android lists no camera."))
        val h = Handler(Looper.getMainLooper()); val lines = ArrayList<String>(); var ok = 0
        ids.forEachIndexed { i, id ->
            p((i + 1f) / ids.size, "Opening camera $id")
            val res = withContext(Dispatchers.Main) { kotlinx.coroutines.withTimeoutOrNull(4000) { suspendCancellableCoroutine<String> { c -> try { cm.openCamera(id, object : CameraDevice.StateCallback() { override fun onOpened(d: CameraDevice) { d.close(); if (c.isActive) c.resume("opened") }; override fun onDisconnected(d: CameraDevice) { d.close(); if (c.isActive) c.resume("disconnected") }; override fun onError(d: CameraDevice, e: Int) { d.close(); if (c.isActive) c.resume("error $e") } }, h) } catch (e: Exception) { if (c.isActive) c.resume("could not open: ${e.javaClass.simpleName}") } } } ?: "no answer" }
            if (res == "opened") ok++; lines.add("Camera $id: $res")
        }
        return LabOutcome(ok == ids.size, "$ok of ${ids.size} open", lines)
    }

    @SuppressLint("MissingPermission")
    private suspend fun mic(ctx: Context, p: (Float, String) -> Unit): LabOutcome {
        val rate = 16000; val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = AudioRecord(MediaRecorder.AudioSource.MIC, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, 8192))
        if (rec.state != AudioRecord.STATE_INITIALIZED) return LabOutcome(false, "Could not start", listOf("The microphone did not start. Another app may be using it."))
        var peak = 0; val buf = ShortArray(2048)
        try { rec.startRecording(); val end = System.currentTimeMillis() + 3000; while (System.currentTimeMillis() < end) { val n = rec.read(buf, 0, buf.size); for (i in 0 until n) peak = maxOf(peak, abs(buf[i].toInt())); p(1f - (end - System.currentTimeMillis()) / 3000f, "Listening") } } finally { try { rec.stop() } catch (e: Exception) { }; rec.release() }
        val pct = peak * 100 / 32767
        return LabOutcome(if (pct < 1) false else true, "peak $pct%", listOf("Loudest level heard: $pct% of the maximum.", if (pct < 1) "Nothing was heard. Say something and test again; if it stays at zero, the microphone or its permission is blocked." else "The microphone picks up sound."))
    }

    @Suppress("DEPRECATION")
    private fun wifi(ctx: Context): LabOutcome {
        val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager; val i = try { wm.connectionInfo } catch (e: Exception) { null }
        if (i == null || i.networkId == -1) return LabOutcome(null, "Not on Wi-Fi", listOf("Connect to a Wi-Fi network and run this again."))
        val band = if (i.frequency > 4900) "5 GHz" else "2.4 GHz"; val rssi = i.rssi; val q = when { rssi > -55 -> "excellent"; rssi > -67 -> "good"; rssi > -75 -> "fair"; else -> "weak" }
        return LabOutcome(null, "${i.linkSpeed} Mbps", listOf("Link speed ${i.linkSpeed} Mbps on $band, signal $rssi dBm ($q).", "Link speed is what the phone and router agree on, not your internet speed."))
    }
}
