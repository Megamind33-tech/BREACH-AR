package com.viro.workcare.daily

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.viro.workcare.MainActivity
import com.viro.workcare.data.Finding
import com.viro.workcare.data.Severity
import com.viro.workcare.phone.PhoneDeepFindings
import com.viro.workcare.phone.PhoneDeepReader
import com.viro.workcare.phone.PhoneFindings
import com.viro.workcare.phone.PhoneReader
import com.viro.workcare.phone.PhoneSnapshot
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** One day's reading of this phone. Real measurements only: a day with no reading has no entry, and nothing is filled in. */
data class DaySnapshot(
    val day: String, val takenAt: Long, val batteryPercent: Int?, val batteryTempC: Double?, val storageFree: Long?, val storageTotal: Long?, val patchAgeDays: Int?,
    val attentionIds: List<String>, val attentionTitles: List<String>, val worst: Int,
)

object DailyStore {
    private fun file(ctx: Context) = File(ctx.filesDir, "daily.json")
    private val fmt get() = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    fun dayKey(ms: Long): String = fmt.format(Date(ms))

    fun load(ctx: Context): List<DaySnapshot> = try {
        val a = JSONArray(file(ctx).takeIf { it.exists() }?.readText() ?: "[]")
        (0 until a.length()).map { val o = a.getJSONObject(it); val ids = o.optJSONArray("ids") ?: JSONArray(); val tt = o.optJSONArray("titles") ?: JSONArray()
            DaySnapshot(o.getString("day"), o.getLong("at"), o.optInt("bat", -1).takeIf { v -> v >= 0 }, if (o.has("temp")) o.getDouble("temp") else null, if (o.has("free")) o.getLong("free") else null, if (o.has("total")) o.getLong("total") else null,
                if (o.has("patch")) o.getInt("patch") else null, (0 until ids.length()).map { i -> ids.getString(i) }, (0 until tt.length()).map { i -> tt.getString(i) }, o.optInt("worst", 0)) }
    } catch (e: Exception) { emptyList() }

    private fun save(ctx: Context, list: List<DaySnapshot>) {
        val a = JSONArray(); list.forEach { s -> a.put(JSONObject().put("day", s.day).put("at", s.takenAt).apply { s.batteryPercent?.let { put("bat", it) }; s.batteryTempC?.let { put("temp", it) }; s.storageFree?.let { put("free", it) }; s.storageTotal?.let { put("total", it) }; s.patchAgeDays?.let { put("patch", it) }
            put("ids", JSONArray(s.attentionIds)); put("titles", JSONArray(s.attentionTitles)); put("worst", s.worst) }) }
        try { file(ctx).writeText(a.toString()) } catch (e: Exception) { }
    }

    /** Stores today's reading (replacing an earlier one from the same day) and keeps a year. */
    fun record(ctx: Context, p: PhoneSnapshot, findings: List<Finding>): DaySnapshot {
        val bad = findings.filter { it.severity != Severity.HEALTHY }
        val snap = DaySnapshot(dayKey(p.takenAtMillis), p.takenAtMillis, p.batteryPercent, p.batteryTempC, p.storageFree, p.storageTotal, PhoneFindings.patchAgeDays(p.securityPatch, p.takenAtMillis)?.toInt(),
            bad.map { it.id }, bad.map { it.title }, findings.fold(Severity.HEALTHY) { a, f -> a.worse(f.severity) }.ordinal)
        val all = (load(ctx).filter { it.day != snap.day } + snap).sortedBy { it.day }.takeLast(365)
        save(ctx, all); return snap
    }

    /** Days in a row, ending today (or yesterday, so the streak is not lost before today's reading is taken). */
    fun streak(list: List<DaySnapshot>, nowMs: Long): Int {
        val days = list.map { it.day }.toSet(); val cal = Calendar.getInstance().apply { timeInMillis = nowMs }
        if (dayKey(cal.timeInMillis) !in days) cal.add(Calendar.DAY_OF_YEAR, -1)
        var n = 0; while (dayKey(cal.timeInMillis) in days) { n++; cal.add(Calendar.DAY_OF_YEAR, -1) }
        return n
    }

    /** What changed between the previous day with a reading and the latest one, as plain sentences. Empty when nothing did. */
    fun changes(list: List<DaySnapshot>): List<String> {
        if (list.size < 2) return emptyList()
        val now = list.last(); val before = list[list.size - 2]; val out = ArrayList<String>()
        now.attentionIds.forEachIndexed { i, id -> if (id !in before.attentionIds) out.add("New: " + now.attentionTitles.getOrElse(i) { id }) }
        before.attentionIds.forEachIndexed { i, id -> if (id !in now.attentionIds) out.add("Resolved: " + before.attentionTitles.getOrElse(i) { id }) }
        if (now.storageFree != null && before.storageFree != null) { val d = (now.storageFree - before.storageFree) / 1073741824.0; if (Math.abs(d) >= 0.5) out.add("Free storage ${if (d > 0) "up" else "down"} ${String.format(Locale.US, "%.1f", Math.abs(d))} GB since ${before.day}") }
        return out
    }

    /**
     * An estimate, labelled as one: how many days until free storage reaches zero if the last readings continue in a straight line.
     * Needs at least seven days that span a week, a steady downward trend, and says nothing otherwise.
     */
    fun storageDaysLeft(list: List<DaySnapshot>): Int? {
        val pts = list.takeLast(30).filter { it.storageFree != null }; if (pts.size < 7) return null
        val t0 = pts.first().takenAt; val xs = pts.map { (it.takenAt - t0) / 86_400_000.0 }; val ys = pts.map { it.storageFree!! / 1073741824.0 }
        if (xs.last() < 6.0) return null
        val mx = xs.average(); val my = ys.average(); val sxx = xs.sumOf { (it - mx) * (it - mx) }; if (sxx == 0.0) return null
        val slope = xs.indices.sumOf { (xs[it] - mx) * (ys[it] - my) } / sxx           // GB per day
        if (slope > -0.05) return null                                                  // flat or growing: no forecast
        val days = (ys.last() / -slope); return if (days in 1.0..720.0) days.toInt() else null
    }
}

object DailyScheduler {
    const val CHANNEL = "daily"
    fun enabled(ctx: Context) = ctx.getSharedPreferences("wc", Context.MODE_PRIVATE).getBoolean("daily_on", false)
    fun setEnabled(ctx: Context, on: Boolean) { ctx.getSharedPreferences("wc", Context.MODE_PRIVATE).edit().putBoolean("daily_on", on).apply(); if (on) schedule(ctx) else cancel(ctx) }
    private fun pi(ctx: Context) = PendingIntent.getBroadcast(ctx, 41, Intent(ctx, DailyCheckReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    /** The next 08:30 local time. Inexact on purpose: Android may run it a little later to save battery. */
    fun schedule(ctx: Context) {
        val cal = Calendar.getInstance().apply { set(Calendar.HOUR_OF_DAY, 8); set(Calendar.MINUTE, 30); set(Calendar.SECOND, 0); if (timeInMillis <= System.currentTimeMillis() + 60_000) add(Calendar.DAY_OF_YEAR, 1) }
        (ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, cal.timeInMillis, pi(ctx))
    }
    fun cancel(ctx: Context) { (ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pi(ctx)) }
    fun channel(ctx: Context) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL) == null) nm.createNotificationChannel(NotificationChannel(CHANNEL, "Daily check", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "Tells you when the daily check finds something that needs you. Silent otherwise." })
    }
}

/** Runs once a day. Reads this phone, stores the reading, and speaks only if something new needs you. */
class DailyCheckReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent?) {
        try {
            if (!DailyScheduler.enabled(ctx)) return
            val prefs = ctx.getSharedPreferences("wc", Context.MODE_PRIVATE)
            val snap = PhoneReader.read(ctx)
            val plus = prefs.getBoolean("plus_active", false)
            val findings = PhoneFindings.evaluate(snap) + (if (plus) PhoneDeepFindings.evaluate(PhoneDeepReader.read(ctx)) else emptyList())
            val before = DailyStore.load(ctx).lastOrNull { it.day != DailyStore.dayKey(snap.takenAtMillis) }
            DailyStore.record(ctx, snap, findings)
            val fresh = findings.filter { it.severity != Severity.HEALTHY && (before == null || it.id !in before.attentionIds) }
            if (fresh.isNotEmpty()) notify(ctx, fresh)
        } finally { if (DailyScheduler.enabled(ctx)) DailyScheduler.schedule(ctx) }
    }
    private fun notify(ctx: Context, fresh: List<Finding>) {
        DailyScheduler.channel(ctx)
        val open = PendingIntent.getActivity(ctx, 42, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val worst = fresh.maxByOrNull { it.severity.ordinal }!!
        val n = Notification.Builder(ctx, DailyScheduler.CHANNEL).setSmallIcon(android.R.drawable.stat_notify_error).setContentTitle(if (fresh.size == 1) worst.title else "${fresh.size} new things need you")
            .setContentText(if (fresh.size == 1) worst.summary else worst.title + " and more").setContentIntent(open).setAutoCancel(true).build()
        try { (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(4101, n) } catch (e: SecurityException) { /* notification permission was withdrawn: the reading is still stored */ }
    }
}

class BootReceiver : BroadcastReceiver() { override fun onReceive(ctx: Context, intent: Intent?) { if (DailyScheduler.enabled(ctx)) DailyScheduler.schedule(ctx) } }
