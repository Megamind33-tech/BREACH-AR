package com.viro.workcare.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.viro.workcare.AppVm
import com.viro.workcare.daily.DailyStore
import com.viro.workcare.data.Component
import com.viro.workcare.data.Severity
import com.viro.workcare.gadget.Condition

/** A utility home: a status line, a dial with the count that matters, four live tools, what to fix with one tap each, and one fixed action to scan. */
@Composable fun HomeScreen(vm: AppVm, go: (String) -> Unit) {
    val ctx = LocalContext.current; val p = vm.phone; val c = Wc.colors
    val all = vm.phoneHealth?.findings.orEmpty(); val bad = all.filter { it.severity != Severity.HEALTHY }.sortedByDescending { it.severity.ordinal }
    val worst = bad.fold(Severity.HEALTHY) { a, f -> a.worse(f.severity) }; val tint = c.status(worst)
    val streak = DailyStore.streak(vm.daily, System.currentTimeMillis())
    fun stateOf(vararg prefixes: String) = all.filter { f -> prefixes.any { f.id.startsWith(it) } }.fold(Severity.HEALTHY) { a, f -> a.worse(f.severity) }.let { if (it == Severity.HEALTHY) c.green else c.status(it) }
    WithCta({ BottomCta("Scan now", "Phone health · security · storage") { go(R.SMART) } }) {
        Page(bottomPad = 110.dp) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("WorkCare", style = Wc.type.title, color = c.text, modifier = Modifier.weight(1f))
                Box(Modifier.size(48.dp).clip(CircleShape).clickable(role = androidx.compose.ui.semantics.Role.Button, onClickLabel = "Alerts") { go(R.ALERTS) }, contentAlignment = Alignment.Center) {
                    WcIcon(WcIcons.Bell, c.text, 24.dp)
                    if (vm.alerts.isNotEmpty()) Box(Modifier.align(Alignment.TopEnd).padding(top = 10.dp, end = 10.dp).size(9.dp).clip(CircleShape).background(if (vm.alerts.any { it.severity == Severity.CRITICAL }) c.critical else c.attention))
                }
            }
            vm.devicesError?.let { Notice(it, Severity.ATTENTION, Modifier.padding(top = 6.dp)) }
            Spacer(Modifier.height(8.dp))
            StatusBanner("YOUR PHONE IS", if (p == null) "BEING READ" else if (bad.isEmpty()) "SAFE" else "${bad.size} TO FIX", if (p == null) c.textSecondary else tint, onClick = if (bad.isEmpty()) null else ({ go(R.RESCUE) }))

            // The dial: the share of checks that passed, with the count that needs you in the middle.
            Spacer(Modifier.height(18.dp))
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                GaugeRing(if (all.isEmpty()) 0f else (all.size - bad.size).toFloat() / all.size, if (p == null) c.textSecondary else tint, size = 232.dp, description = if (all.isEmpty()) "Phone health, reading" else "${all.size - bad.size} of ${all.size} checks passed") {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        if (bad.isEmpty() && p != null) { WcIcon(WcIcons.Tick, tint, 64.dp); Text("SAFE", style = Wc.type.section.copy(fontWeight = FontWeight.Bold, letterSpacing = 3.sp), color = c.text) }
                        else { Text("${bad.size}", style = Wc.type.numeralLarge.copy(fontSize = 72.sp, lineHeight = 76.sp), color = c.text); Text("TO FIX", style = Wc.type.section.copy(fontWeight = FontWeight.Bold, letterSpacing = 3.sp), color = tint) }
                        Text("${all.size - bad.size} of ${all.size} checks passed", style = Wc.type.meta, color = c.textSecondary, modifier = Modifier.padding(top = 6.dp))
                    }
                }
            }
            Text(buildString { append(if (p == null) "Reading this phone" else "Checked " + agoText(p.takenAtMillis)); if (streak >= 2) append(" · $streak days in a row") }, style = Wc.type.data, color = c.textSecondary, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 4.dp))

            // The verdict on this phone, from the same decision logic the Windows product uses.
            vm.phoneReport?.let { rp ->
                Spacer(Modifier.height(16.dp)); val at = actionTint(rp.verdict.action)
                WcCard(accent = at, onClick = { go(R.gadget(R.THIS_PHONE)) }) {
                    Row(verticalAlignment = Alignment.CenterVertically) { Eyebrow("This phone's verdict", color = at, modifier = Modifier.weight(1f)); WcIcon(WcIcons.Chevron, c.textSecondary, 18.dp) }
                    Text(rp.verdict.action.short, style = Wc.type.numeralLarge.copy(fontSize = 30.sp, lineHeight = 34.sp), color = at, modifier = Modifier.padding(top = 6.dp))
                    Text(rp.verdict.headline, style = Wc.type.section, color = c.text)
                    Text(rp.age.headline + " · ${rp.parts.count { it.condition.rank >= Condition.WATCH.rank }} of ${rp.parts.size} parts show wear or need a look", style = Wc.type.data, color = c.textSecondary, modifier = Modifier.padding(top = 4.dp))
                }
            }
            // Four live tools.
            Spacer(Modifier.height(18.dp))
            val secBad = bad.count { it.component == Component.SECURITY || it.component == Component.NETWORK || it.component == Component.APPS || it.id == "system.security_patch" }
            val gb = { b: Long -> String.format(java.util.Locale.US, "%.1f", b / 1073741824.0).removeSuffix(".0") }
            val tools: List<@Composable (Modifier) -> Unit> = listOf(
                { m -> ToolCard(WcIcons.Clean, "Clean", if (vm.lastCleanBytes >= 0) bytesText(vm.lastCleanBytes) else "Scan", if (vm.lastCleanBytes >= 0) "of leftovers found" else "Find hidden and junk files", c.green, m) { go(R.CLEAN) } },
                { m -> ToolCard(WcIcons.Check, "Security", if (secBad == 0) "Clear" else "$secBad", if (secBad == 0) (if (vm.phoneDeep == null) "Basic checks only" else "Deep audit passed") else "to look at", if (secBad == 0) c.green else c.attention, m) { go(R.RESCUE) } },
                { m -> ToolCard(WcIcons.Battery, "Battery", p?.batteryPercent?.let { "$it%" } ?: "n/a", listOfNotNull(if (p?.charging == true) "Charging" else "On battery", p?.batteryTempC?.let { "${it.toInt()}°C" }).joinToString(" · "), stateOf("battery.", "thermal."), m) { Fixes.open(ctx, android.content.Intent.ACTION_POWER_USAGE_SUMMARY) } },
                { m -> ToolCard(WcIcons.Chip, "Memory", p?.memAvail?.let { gb(it) + " GB" } ?: "n/a", p?.memTotal?.let { "free of ${gb(it)} GB" } ?: "Not available on this device", stateOf("memory."), m) { Fixes.open(ctx, android.provider.Settings.ACTION_MANAGE_ALL_APPLICATIONS_SETTINGS) } },
            )
            val big = androidx.compose.ui.platform.LocalDensity.current.fontScale > 1.25f
            if (big) Column(verticalArrangement = Arrangement.spacedBy(12.dp)) { tools.forEach { it(Modifier.fillMaxWidth()) } }
            else tools.chunked(2).forEach { pair -> Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) { pair.forEach { t -> t(Modifier.weight(1f)) } } }

            if (bad.isNotEmpty()) {
                SectionHeader("To fix")
                bad.take(4).forEach { f ->
                    val act = Fixes.forFinding(f)
                    WcCard(accent = c.status(f.severity), padding = 16.dp) {
                        Row(verticalAlignment = Alignment.CenterVertically) { StatusDot(f.severity, 10.dp); Spacer(Modifier.width(10.dp)); Text(f.title, style = Wc.type.bodyStrong.copy(fontWeight = FontWeight.SemiBold), color = c.text) }
                        Text(f.summary, style = Wc.type.data, color = c.textSecondary, maxLines = 3, modifier = Modifier.padding(top = 4.dp))
                        if (act != null) { Spacer(Modifier.height(10.dp)); SecondaryButton(act.label, { runFix(ctx, act, go) }) }
                    }
                    Spacer(Modifier.height(10.dp))
                }
                if (bad.size > 4) TextAction("All ${bad.size} in Fix", { go(R.RESCUE) })
            }

            SectionHeader("More")
            WcGroup {
                ListRow("Scan a PC", subtitle = "With WorkCare QuickCheck", onClick = { go(R.CHECK) }, chevron = true, leading = { IconBadge(WcIcons.Laptop, c.green, 40.dp) })
                ListRow("Test phone hardware", subtitle = "Screen, touch, vibration, flash, speaker", onClick = { go(R.PHONE_TESTS) }, chevron = true, leading = { IconBadge(WcIcons.Phone, c.green, 40.dp) })
            }
            if (p != null) { Spacer(Modifier.height(14.dp)); DeepAuditCard(vm, go); Spacer(Modifier.height(10.dp)); TodayCard(vm, go) }
            if (vm.signedIn) { SectionHeader("Devices", action = "All", onAction = { go(R.DEVICES) }); WcGroup { deviceRows(vm).filter { it.id != R.THIS_PHONE }.take(3).forEach { r -> ListRow(r.name, subtitle = r.model, onClick = { go(R.device(r.id)) }, trailing = { StatusPill(r.status) }, chevron = true) } } }
        }
    }
}

fun runFix(ctx: android.content.Context, a: FixAction, go: (String) -> Unit) {
    when (a) {
        is FixAction.Settings -> Fixes.open(ctx, a.action)
        is FixAction.Tool -> go(a.route)
        is FixAction.Instruction -> try { ctx.startActivity(android.content.Intent(android.provider.Settings.ACTION_SETTINGS).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (e: Exception) { }
    }
}

@Composable fun SmallAction(label: String, onClick: () -> Unit) {
    Box(Modifier.clip(RoundedCornerShape(12.dp)).border(androidx.compose.foundation.BorderStroke(1.dp, Wc.colors.green.copy(alpha = .6f)), RoundedCornerShape(12.dp)).clickable(role = androidx.compose.ui.semantics.Role.Button, onClick = onClick).padding(horizontal = 12.dp, vertical = 10.dp)) {
        Text(label, style = Wc.type.data.copy(fontWeight = FontWeight.SemiBold), color = Wc.colors.green, maxLines = 2, modifier = Modifier.widthIn(max = 120.dp))
    }
}
