package com.viro.workcare.ui

import android.Manifest
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.viro.workcare.AppVm
import com.viro.workcare.daily.DailyStore
import com.viro.workcare.daily.DaySnapshot

/** The reason to open WorkCare again tomorrow, and the only reasons that are true: what changed since last time, how many days in a row it has been checked, and a check that speaks only when something new needs you. */
@Composable fun TodayCard(vm: AppVm, go: (String) -> Unit, modifier: Modifier = Modifier) {
    val ctx = LocalContext.current; val list = vm.daily; val streak = DailyStore.streak(list, System.currentTimeMillis()); val changes = DailyStore.changes(list)
    val askPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { vm.setDaily(true) }
    // Android updates this a moment after the person answers the prompt, so it is read again shortly after the switch changes.
    val notificationsOn by androidx.compose.runtime.produceState(true, vm.dailyOn) { kotlinx.coroutines.delay(700); value = (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).areNotificationsEnabled() }
    WcCard(modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Eyebrow("Today", color = Wc.colors.green, modifier = Modifier.weight(1f))
            if (streak >= 2) Chip("$streak days in a row", tint = Wc.colors.green)
        }
        Text(when { list.size < 2 -> "First reading saved"; changes.isEmpty() -> "Nothing has changed"; else -> "Since ${list[list.size - 2].day}" }, style = Wc.type.section, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp))
        if (list.size < 2) Text("Open WorkCare tomorrow, or turn on the daily check, and this shows what changed on your phone.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 4.dp))
        else if (changes.isEmpty()) Text("Your phone's readings and findings are the same as on ${list[list.size - 2].day}.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 4.dp))
        else changes.take(4).forEach { Text(it, style = Wc.type.data, color = Wc.colors.text, modifier = Modifier.padding(top = 5.dp)) }
        Spacer(Modifier.height(14.dp))
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Wc.colors.surface.copy(alpha = .6f)).clickable {
            if (vm.dailyOn) vm.setDaily(false)
            else if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) askPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            else vm.setDaily(true)
        }.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Daily check, 8:30", style = Wc.type.bodyStrong, color = Wc.colors.text)
                Text(if (!vm.dailyOn) "Off. Reads this phone each morning." else if (!notificationsOn) "On, but notifications are blocked, so it runs silently." else "On. Silent unless something new needs you.", style = Wc.type.data, color = Wc.colors.textSecondary)
            }
            Spacer(Modifier.width(10.dp)); StatusPill(if (vm.dailyOn) com.viro.workcare.data.Severity.HEALTHY else com.viro.workcare.data.Severity.ATTENTION, if (vm.dailyOn) "On" else "Off")
        }
        TextAction("See trends", { go(R.TRENDS) }, modifier = Modifier.padding(top = 4.dp))
    }
}

@Composable fun TrendsScreen(vm: AppVm, go: (String) -> Unit, back: () -> Unit) {
    val all = vm.daily; val window = if (vm.plus) 90 else 7
    val cutoff = DailyStore.dayKey(System.currentTimeMillis() - window * 86_400_000L); val list = all.filter { it.day >= cutoff }
    Page {
        TopBar(onBack = back)
        Eyebrow("Trends", color = Wc.colors.green)
        Text("This phone over time", style = Wc.type.title, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp))
        Text("Real readings, one per day, kept on this phone. Showing the last $window days${if (!vm.plus) ". WorkCare Plus keeps 90." else "."}", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 4.dp, bottom = 16.dp))
        if (list.size < 3) EmptyState(WcIcons.Home, "Trends need a few days", "You have ${list.size} reading${if (list.size == 1) "" else "s"} so far. A trend needs at least three. Open WorkCare each day, or turn on the daily check.") { SecondaryButton("Back", back) }
        else {
            Chart("Free storage", "GB", list.map { it.storageFree?.let { v -> v / 1073741824.0 } }, list, Wc.colors.green)
            if (list.any { it.batteryTempC != null }) Chart("Battery temperature", "Â°C", list.map { it.batteryTempC }, list, Wc.colors.attention)
            if (list.any { it.patchAgeDays != null }) Chart("Days since security patch", "days", list.map { it.patchAgeDays?.toDouble() }, list, Wc.colors.attention)
            Chart("Things needing attention", "", list.map { it.attentionIds.size.toDouble() }, list, Wc.colors.critical, whole = true)
            SectionHeader("Forecast")
            val left = DailyStore.storageDaysLeft(all)
            if (!vm.plus) WcCard { Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) { WcIcon(WcIcons.Lock, Wc.colors.green, 18.dp); Eyebrow("Plus", color = Wc.colors.green) }; Text("Storage forecast", style = Wc.type.section, color = Wc.colors.text, modifier = Modifier.padding(top = 6.dp)); Text("When free storage is likely to run out, from your own readings. Not run in the free plan, so nothing is claimed.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 4.dp, bottom = 12.dp)); PrimaryButton("See what Plus includes", { go(R.PLUS) }) }
            else WcCard {
                Row(verticalAlignment = Alignment.CenterVertically) { Text("Storage forecast", style = Wc.type.section, color = Wc.colors.text, modifier = Modifier.weight(1f)); EvidenceTag(com.viro.workcare.data.EvidenceType.INFERRED) }
                Text(if (left != null) "At the pace of the last weeks, free storage would reach zero in about $left days." else "No forecast: free storage is steady, or there are not yet seven days spanning a week.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 6.dp))
                if (left != null) Text("A straight-line estimate from your own readings. Photos, updates and downloads change it. Not a promise.", style = Wc.type.meta, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 6.dp))
            }
        }
    }
}

@Composable private fun Chart(title: String, unit: String, values: List<Double?>, days: List<DaySnapshot>, tint: Color, whole: Boolean = false) {
    val present = values.filterNotNull(); if (present.isEmpty()) return
    val lo = present.min(); val hi = present.max(); val span = (hi - lo).takeIf { it > 1e-9 } ?: 1.0
    fun f(v: Double) = if (whole) v.toInt().toString() else String.format(java.util.Locale.US, "%.1f", v).removeSuffix(".0")
    WcCard(Modifier.padding(bottom = 12.dp), padding = 16.dp) {
        Row(verticalAlignment = Alignment.Bottom) { Text(title, style = Wc.type.bodyStrong, color = Wc.colors.text, modifier = Modifier.weight(1f)); Text(f(present.last()) + (if (unit.isNotEmpty()) " $unit" else ""), style = Wc.type.numeral.copy(fontSize = androidx.compose.ui.unit.TextUnit(20f, androidx.compose.ui.unit.TextUnitType.Sp)), color = tint) }
        val grid = Wc.colors.border
        Canvas(Modifier.fillMaxWidth().height(86.dp).padding(top = 12.dp).semantics { contentDescription = "$title over ${days.size} days: from ${f(present.first())} to ${f(present.last())}, lowest ${f(lo)}, highest ${f(hi)}" }) {
            val w = size.width; val h = size.height; val n = values.size
            fun x(i: Int) = if (n == 1) w / 2 else w * i / (n - 1).toFloat()
            fun y(v: Double) = (h - ((v - lo) / span).toFloat() * (h - 8.dp.toPx()) - 4.dp.toPx())
            drawLine(grid.copy(alpha = .18f), Offset(0f, h - 1f), Offset(w, h - 1f), 1.dp.toPx())
            val path = Path(); var started = false
            values.forEachIndexed { i, v -> if (v != null) { if (!started) { path.moveTo(x(i), y(v)); started = true } else path.lineTo(x(i), y(v)) } }
            drawPath(path, tint, style = Stroke(2.2.dp.toPx(), cap = StrokeCap.Round))
            values.forEachIndexed { i, v -> if (v != null) drawCircle(tint, 3.2.dp.toPx(), Offset(x(i), y(v))) }
        }
        Row(Modifier.fillMaxWidth().padding(top = 6.dp)) { Text(days.first().day.substring(5), style = Wc.type.meta, color = Wc.colors.textSecondary, modifier = Modifier.weight(1f)); Text("low " + f(lo) + " Â· high " + f(hi), style = Wc.type.meta, color = Wc.colors.textSecondary); Spacer(Modifier.width(8.dp)); Text(days.last().day.substring(5), style = Wc.type.meta.copy(fontWeight = FontWeight.Medium), color = Wc.colors.textSecondary) }
    }
}
