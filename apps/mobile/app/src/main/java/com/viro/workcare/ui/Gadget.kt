package com.viro.workcare.ui

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.viro.workcare.AppVm
import com.viro.workcare.data.Severity
import com.viro.workcare.gadget.Action
import com.viro.workcare.gadget.Condition
import com.viro.workcare.gadget.GadgetReport
import com.viro.workcare.gadget.Kind
import com.viro.workcare.gadget.LabStore
import com.viro.workcare.gadget.LabTest
import com.viro.workcare.gadget.Part
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

@Composable fun conditionTint(c: Condition): Color = when (c) { Condition.HEALTHY -> Wc.colors.green; Condition.WATCH, Condition.DEGRADED -> Wc.colors.attention; Condition.REPLACEMENT_ADVISED, Condition.CRITICAL -> Wc.colors.critical; Condition.NOT_MEASURED -> Wc.colors.textSecondary }
@Composable fun actionTint(a: Action): Color = when (a) { Action.KEEP -> Wc.colors.green; Action.MONITOR, Action.MAINTAIN, Action.REPAIR -> Wc.colors.attention; Action.REPLACE -> Wc.colors.critical }
@Composable fun ConditionPill(c: Condition, modifier: Modifier = Modifier) {
    val t = conditionTint(c)
    Row(modifier.clip(RoundedCornerShape(50)).background(t.copy(alpha = .14f)).padding(horizontal = 10.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) { Box(Modifier.size(6.dp).clip(RoundedCornerShape(3.dp)).background(t)); Spacer(Modifier.width(6.dp)); Text(c.label, style = Wc.type.meta.copy(fontWeight = FontWeight.SemiBold), color = t, maxLines = 1) }
}

fun reportText(r: GadgetReport): String = buildString {
    appendLine("WorkCare report: ${r.name}"); appendLine("Checked ${SimpleDateFormat("d MMM yyyy, HH:mm", Locale.US).format(Date(r.takenAt))}"); appendLine()
    appendLine("VERDICT: ${r.verdict.action.label.uppercase()} - ${r.verdict.headline}"); r.verdict.reasons.forEach { appendLine("  - $it") }; appendLine("Confidence: ${r.verdict.confidence}"); appendLine()
    appendLine("AGE: ${r.age.headline}"); r.age.lines.forEach { appendLine("  - $it") }; appendLine()
    appendLine("PARTS"); r.parts.forEach { appendLine("  ${it.label}: ${it.condition.label} (${it.headline}) [${it.type.label}]"); it.evidence.forEach { e -> appendLine("      $e") }; if (it.condition.rank >= Condition.WATCH.rank) appendLine("      -> ${it.action}") }; appendLine()
    r.facts.groupBy { it.group }.forEach { (g, l) -> appendLine(g.uppercase()); l.forEach { appendLine("  ${it.label}: ${it.value}") }; appendLine() }
    appendLine("Made by WorkCare. Evidence labels: MEASURED = read from the device, TESTED = a test was run, INFERRED = worked out from other readings. WorkCare does not predict failures.")
}

// ------------------------------------------------------------------------------------------------------------ the report
@Composable fun GadgetReportScreen(vm: AppVm, id: String, back: () -> Unit, go: (String) -> Unit) {
    val ctx = LocalContext.current; val c = Wc.colors; val r = vm.reportFor(id)
    var open by remember { mutableStateOf<String?>(null) }
    if (r == null) { Page { TopBar(onBack = back); Text("This report is not available. Scan the gadget again.", style = Wc.type.body, color = c.textSecondary) }; return }
    val tint = actionTint(r.verdict.action); val isPhone = r.kind == Kind.PHONE
    val year = Calendar.getInstance().get(Calendar.YEAR); val bought = vm.boughtYear(id)
    WithCta({ BottomCta("Share report", "Send it as text") { ctx.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_SUBJECT, "WorkCare report: ${r.name}").putExtra(Intent.EXTRA_TEXT, reportText(r)), "Share report")) } }) {
        Page(bottomPad = 110.dp) {
            TopBar(onBack = back)
            Row(verticalAlignment = Alignment.CenterVertically) {
                val (mk, md) = if (isPhone) (vm.phone?.manufacturer to vm.phone?.model) else makerModel(r.model)
                DevicePhotoImage(rememberDevicePhoto(vm, id, mk, md, isPhone), Modifier.size(64.dp).clip(RoundedCornerShape(14.dp)), description = "Picture of ${r.name}", crop = true)
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) { Text(r.name, style = Wc.type.section, color = c.text, maxLines = 2); Text(r.kind.label + " · checked " + agoText(r.takenAt), style = Wc.type.data, color = c.textSecondary) }
            }
            Spacer(Modifier.height(14.dp))

            // The verdict.
            WcCard(accent = tint) {
                Row(verticalAlignment = Alignment.CenterVertically) { Eyebrow("Verdict", color = tint, modifier = Modifier.weight(1f)); Chip("Confidence " + r.verdict.confidence.lowercase(), tint = c.textSecondary) }
                Text(r.verdict.action.short, style = Wc.type.numeralLarge.copy(fontSize = 34.sp, lineHeight = 38.sp), color = tint, modifier = Modifier.padding(top = 8.dp))
                Text(r.verdict.headline, style = Wc.type.section, color = c.text, modifier = Modifier.padding(top = 2.dp))
                r.verdict.reasons.forEach { Row(Modifier.padding(top = 8.dp)) { Box(Modifier.padding(top = 8.dp).size(5.dp).clip(RoundedCornerShape(3.dp)).background(tint)); Spacer(Modifier.width(10.dp)); Text(it, style = Wc.type.data, color = c.textSecondary) } }
            }

            // Age.
            SectionHeader("How old")
            WcCard {
                Text(r.age.headline, style = Wc.type.section, color = c.text)
                r.age.lines.forEach { Text(it, style = Wc.type.data, color = c.textSecondary, modifier = Modifier.padding(top = 6.dp)) }
                Spacer(Modifier.height(12.dp)); Text("When did you get it?", style = Wc.type.meta, color = c.textSecondary)
                Row(Modifier.horizontalScroll(rememberScrollState()).padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf<Int?>(null) .plus((year downTo year - 9).toList()).forEach { y ->
                        val on = (y == null && bought == null) || y == bought
                        Box(Modifier.clip(RoundedCornerShape(50)).background(if (on) c.green else c.surface).clickable(role = Role.RadioButton) { vm.setBoughtYear(id, y); if (!isPhone) vm.reportFor(id) }.padding(horizontal = 14.dp, vertical = 10.dp)) { Text(y?.toString() ?: "Not sure", style = Wc.type.data.copy(fontWeight = FontWeight.SemiBold), color = if (on) c.onGreen else c.text) }
                    }
                }
            }

            // Parts.
            SectionHeader("What is worn")
            WcGroup {
                r.parts.forEach { p ->
                    Column {
                        Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { open = if (open == p.key) null else p.key }.padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) { Text(p.label, style = Wc.type.bodyStrong, color = c.text); Text(p.headline, style = Wc.type.data, color = c.textSecondary, maxLines = 2) }
                            Spacer(Modifier.width(8.dp)); ConditionPill(p.condition)
                        }
                        if (open == p.key) Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 14.dp)) {
                            p.evidence.forEach { Text(it, style = Wc.type.data, color = c.textSecondary, modifier = Modifier.padding(bottom = 4.dp)) }
                            if (p.action.isNotBlank()) Text(p.action, style = Wc.type.data.copy(fontWeight = FontWeight.Medium), color = c.text, modifier = Modifier.padding(top = 4.dp))
                            Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) { EvidenceTag(p.type) }
                        }
                        Hairline(Modifier.padding(start = 16.dp))
                    }
                }
            }
            if (r.parts.any { it.condition == Condition.NOT_MEASURED }) Text("Parts marked Not measured could not be read. WorkCare does not guess them. ${if (isPhone) "Run the matching test in the Lab." else ""}", style = Wc.type.data, color = c.textSecondary, modifier = Modifier.padding(top = 8.dp))

            // Facts.
            r.facts.groupBy { it.group }.forEach { (g, l) -> SectionHeader(g); WcGroup { l.forEach { KeyValueRow(it.label, it.value) } } }

            SectionHeader("Next")
            WcGroup {
                if (isPhone) ListRow("Run lab tests", subtitle = "Charger, storage speed, sensors, cameras, microphone", onClick = { go(R.LAB) }, chevron = true, leading = { IconBadge(WcIcons.Radar, c.green, 40.dp) })
                ListRow("Deal check", subtitle = "Is the price right, given what is worn?", onClick = { go(R.DEAL) }, chevron = true, leading = { IconBadge(WcIcons.Check, c.green, 40.dp) })
                if (!isPhone) ListRow("Remove this report", onClick = { vm.removeGadget(id); back() }, leading = { IconBadge(WcIcons.Close, c.textSecondary, 40.dp) })
            }
            Text("WorkCare states what it measured and what it could not. It does not predict when anything will fail.", style = Wc.type.data, color = c.textSecondary, modifier = Modifier.padding(top = 14.dp))
        }
    }
}

// ------------------------------------------------------------------------------------------------------------ the lab
@Composable fun LabScreen(vm: AppVm, back: () -> Unit, go: (String) -> Unit) {
    val c = Wc.colors
    Page {
        TopBar(onBack = back)
        Text("Lab", style = Wc.type.title, color = c.text, modifier = Modifier.padding(top = 4.dp))
        Text("Real tests on this phone. Each result is saved and counts toward its report.", style = Wc.type.data, color = c.textSecondary, modifier = Modifier.padding(top = 4.dp, bottom = 14.dp))
        val tiles: List<@Composable (Modifier) -> Unit> = LabTest.entries.map { t -> { m ->
            val r = vm.lab[t.id]
            ToolCard(when (t) { LabTest.CHARGER -> WcIcons.Battery; LabTest.STORAGE -> WcIcons.Chip; LabTest.CPU -> WcIcons.Chip; LabTest.SENSORS -> WcIcons.Radar; LabTest.CAMERA -> WcIcons.Photo; LabTest.MIC -> WcIcons.Bell; LabTest.WIFI -> WcIcons.Radar }, t.title, r?.value ?: "Run", r?.let { "tested " + agoText(it.at) } ?: "Not tested yet", if (r?.ok == false) c.attention else c.green, m) { go(R.lab(t.id)) }
        } }
        val big = androidx.compose.ui.platform.LocalDensity.current.fontScale > 1.25f
        if (big) Column(verticalArrangement = Arrangement.spacedBy(12.dp)) { tiles.forEach { it(Modifier.fillMaxWidth()) } } else tiles.chunked(2).forEach { pair -> Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) { pair.forEach { t -> t(Modifier.weight(1f)) }; if (pair.size == 1) Spacer(Modifier.weight(1f)) } }
        SectionHeader("Tests you judge by eye")
        WcGroup {
            listOf("screen" to "Screen", "touch" to "Touch", "vibration" to "Vibration", "flash" to "Flash", "speaker" to "Speaker", "charging" to "Charging").forEach { (id, label) ->
                val r = vm.lab[id]
                ListRow(label, subtitle = r?.let { "${it.value} · " + agoText(it.at) } ?: "Not tested yet", onClick = { go(R.PHONE_TESTS) }, chevron = true, trailing = { r?.ok?.let { ok -> ConditionPill(if (ok) Condition.HEALTHY else Condition.DEGRADED) } })
            }
        }
    }
}

@Composable fun LabTestScreen(vm: AppVm, id: String, back: () -> Unit) {
    val t = LabTest.entries.firstOrNull { it.id == id } ?: run { back(); return }; val c = Wc.colors; val running = vm.labRunning == t; val out = vm.labOutcome
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) vm.runLab(t) }
    val ctx = LocalContext.current
    val last = vm.lab[t.id]; val history = remember(last) { LabStore.history(ctx, t.id) }
    WithCta({ BottomCta(if (running) "Testing" else if (last != null) "Run again" else "Run test", if (running) vm.labStep else null, enabled = !running) {
        vm.clearLabOutcome()
        if (t.needs != null && androidx.core.content.ContextCompat.checkSelfPermission(ctx, t.needs) != android.content.pm.PackageManager.PERMISSION_GRANTED) launcher.launch(t.needs) else vm.runLab(t)
    } }) {
        Page(bottomPad = 110.dp) {
            TopBar(onBack = { vm.clearLabOutcome(); back() })
            Text(t.title, style = Wc.type.title, color = c.text, modifier = Modifier.padding(top = 4.dp))
            Text(t.what, style = Wc.type.data, color = c.textSecondary, modifier = Modifier.padding(top = 6.dp, bottom = 16.dp))
            val shown = out ?: last?.let { com.viro.workcare.gadget.LabOutcome(it.ok, it.value, emptyList()) }
            val tint = when (shown?.ok) { true -> c.green; false -> c.attention; null -> c.green }
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                GaugeRing(if (running) vm.labProgress else if (shown != null) 1f else 0f, tint, size = 224.dp, description = "Test progress") {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        if (running) { Text("${(vm.labProgress * 100).toInt()}%", style = Wc.type.numeralLarge.copy(fontSize = 56.sp, lineHeight = 60.sp), color = c.text); Text(vm.labStep.uppercase(), style = Wc.type.meta.copy(letterSpacing = 2.sp), color = c.textSecondary) }
                        else if (shown != null) { Text(shown.value, style = Wc.type.numeralLarge.copy(fontSize = if (shown.value.length > 10) 28.sp else 40.sp, lineHeight = 44.sp), color = c.text, textAlign = androidx.compose.ui.text.style.TextAlign.Center); Text(when (shown.ok) { true -> "PASSED"; false -> "PROBLEM"; null -> "RESULT" }, style = Wc.type.meta.copy(letterSpacing = 2.sp, fontWeight = FontWeight.Bold), color = tint) }
                        else Text("READY", style = Wc.type.section.copy(letterSpacing = 3.sp, fontWeight = FontWeight.Bold), color = c.textSecondary)
                    }
                }
            }
            out?.detail?.forEach { Text(it, style = Wc.type.data, color = c.text, modifier = Modifier.padding(top = 10.dp)) }
            if (history.size >= 2 && out == null) { SectionHeader("Previous runs"); WcGroup { history.takeLast(6).reversed().forEach { (at, v) -> KeyValueRow(SimpleDateFormat("d MMM, HH:mm", Locale.US).format(Date(at)), v.toInt().toString()) } } }
            if (t.needs != null) Text("WorkCare asks for ${if (t == LabTest.CAMERA) "camera" else "microphone"} permission only when you start this test. Nothing is recorded or kept.", style = Wc.type.meta, color = c.textSecondary, modifier = Modifier.padding(top = 14.dp))
        }
    }
}

// ------------------------------------------------------------------------------------------------------------ the deal check
@Composable fun DealScreen(vm: AppVm, back: () -> Unit, go: (String) -> Unit) {
    val c = Wc.colors; val list = vm.gadgets
    var pick by remember { mutableStateOf<String?>(null) }; var price by remember { mutableStateOf("") }; var ref by remember { mutableStateOf("") }; var claimYear by remember { mutableStateOf("") }
    val quotes = remember { mutableStateOf(mapOf<String, String>()) }; val checks = remember { mutableStateOf(setOf<String>()) }
    val r = list.firstOrNull { it.id == pick }
    Page {
        TopBar(onBack = back)
        Text("Deal check", style = Wc.type.title, color = c.text, modifier = Modifier.padding(top = 4.dp))
        Text("Is the price right for what is worn? Every number below comes from a report or from you.", style = Wc.type.data, color = c.textSecondary, modifier = Modifier.padding(top = 4.dp, bottom = 12.dp))
        SectionHeader("1 · The gadget")
        if (list.isEmpty()) EmptyState(WcIcons.Check, "No reports yet", "Scan the phone or computer you are thinking of buying (open WorkCare on it, or use QuickCheck for a PC). Its report shows up here.") { PrimaryButton("Scan a gadget", { go(R.CHECK) }) }
        else WcGroup { list.forEach { g -> ListRow(g.name, subtitle = g.kind.label + " · " + g.verdict.headline, onClick = { pick = g.id }, trailing = { if (pick == g.id) WcIcon(WcIcons.Tick, c.green, 20.dp) else StatusPill(if (g.verdict.action == Action.KEEP) Severity.HEALTHY else if (g.verdict.action == Action.REPLACE) Severity.CRITICAL else Severity.ATTENTION, g.verdict.action.short) }) } }
        if (r != null) {
            val worn = r.parts.filter { it.condition.rank >= Condition.WATCH.rank }
            SectionHeader("2 · The price")
            WcField(price, { price = it.filter { ch -> ch.isDigit() || ch == '.' } }, "Asking price", numeric = true); Spacer(Modifier.height(10.dp))
            WcField(ref, { ref = it.filter { ch -> ch.isDigit() || ch == '.' } }, "A comparable one in good condition costs (optional)", numeric = true); Spacer(Modifier.height(10.dp))
            WcField(claimYear, { claimYear = it.filter { ch -> ch.isDigit() }.take(4) }, "Year the seller says it is from (optional)", numeric = true)
            if (worn.isNotEmpty()) { SectionHeader("3 · What fixing it costs"); Text("Enter a quote for each worn part. Leave blank if you do not know.", style = Wc.type.data, color = c.textSecondary, modifier = Modifier.padding(bottom = 8.dp)); worn.forEach { p -> WcField(quotes.value[p.key] ?: "", { v -> quotes.value = quotes.value + (p.key to v.filter { ch -> ch.isDigit() || ch == '.' }) }, "${p.label} (${p.condition.label.lowercase()}): repair or replacement", numeric = true); Spacer(Modifier.height(10.dp)) } }
            SectionHeader("${if (worn.isNotEmpty()) 4 else 3} · In the shop")
            val items = if (r.kind == Kind.PHONE) listOf("Screen has no cracks or lines", "Body has no bends or water-damage marks", "No account lock on the screen (Google or Apple)", "IMEI on the box matches the phone (dial *#06#)", "SIM works and gets signal", "Buttons and charging port feel firm") else listOf("Screen has no cracks, lines or dead pixels", "Hinges are firm, lid closes flat", "Every key types, trackpad clicks", "All ports work (USB, charging, HDMI)", "Serial number matches the box and the seller's papers", "No BIOS or account lock")
            WcGroup { items.forEach { it0 -> val on = it0 in checks.value; Row(Modifier.fillMaxWidth().clickable(role = Role.Checkbox) { checks.value = if (on) checks.value - it0 else checks.value + it0 }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) { Box(Modifier.size(22.dp).clip(RoundedCornerShape(6.dp)).background(if (on) c.green else Color.Transparent).then(if (on) Modifier else Modifier.border(androidx.compose.foundation.BorderStroke(2.dp, c.textSecondary), RoundedCornerShape(6.dp))), contentAlignment = Alignment.Center) { if (on) WcIcon(WcIcons.Tick, c.onGreen, 16.dp) }; Spacer(Modifier.width(12.dp)); Text(it0, style = Wc.type.data, color = c.text) }; Hairline(Modifier.padding(start = 16.dp)) } }

            // The answer.
            val p = price.toDoubleOrNull(); val rf = ref.toDoubleOrNull(); val repair = quotes.value.values.mapNotNull { it.toDoubleOrNull() }.sum(); val unchecked = items.size - checks.value.size
            val flags = ArrayList<String>(); val y = claimYear.toIntOrNull(); val bitsAge = r.age.approxYears
            if (y != null && bitsAge != null && r.age.confidence != "LOW") { val real = Calendar.getInstance().get(Calendar.YEAR) - bitsAge.toInt(); if (y > real + 1) flags.add("The seller says $y, but the evidence points to about $real. The gadget looks older than claimed.") }
            if (y != null && r.kind == Kind.PHONE) r.facts.firstOrNull { it.label == "Shipped with Android" }?.value?.substringAfter("(")?.substringBefore(")")?.toIntOrNull()?.let { s -> if (y < s) flags.add("The seller says $y, but this phone shipped with software released in $s, so it cannot be from $y.") }
            val critical = r.parts.any { it.condition == Condition.CRITICAL }
            val call = when { critical || r.verdict.action == Action.REPLACE || flags.isNotEmpty() -> "WALK AWAY"; worn.isNotEmpty() || unchecked > 0 -> "NEGOTIATE"; else -> "BUY" }
            val tint = when (call) { "BUY" -> c.green; "NEGOTIATE" -> c.attention; else -> c.critical }
            SectionHeader("The answer")
            WcCard(accent = tint) {
                Eyebrow("Verdict", color = tint); Text(call, style = Wc.type.numeralLarge.copy(fontSize = 38.sp, lineHeight = 42.sp), color = tint, modifier = Modifier.padding(top = 6.dp))
                if (p != null) { Text("Asking ${"%,.0f".format(p)}" + if (repair > 0) " + repairs ${"%,.0f".format(repair)} = ${"%,.0f".format(p + repair)} to get it into good shape" else "", style = Wc.type.section, color = c.text, modifier = Modifier.padding(top = 6.dp)); if (rf != null && rf > 0) Text("That is ${"%.0f".format((p + repair) / rf * 100)}% of the ${"%,.0f".format(rf)} a comparable one costs.", style = Wc.type.data, color = c.textSecondary, modifier = Modifier.padding(top = 4.dp)) }
                val why = ArrayList<String>(); flags.forEach { why.add(it) }; if (critical) why.add("A part is in critical condition."); if (r.verdict.action == Action.REPLACE) why.add("WorkCare's verdict on this gadget is: ${r.verdict.headline.lowercase()}.")
                worn.forEach { why.add("${it.label}: ${it.condition.label.lowercase()}, ${it.headline}.") }; if (unchecked > 0) why.add("$unchecked shop check${if (unchecked == 1) "" else "s"} not done yet.")
                why.forEach { Text("• $it", style = Wc.type.data, color = c.textSecondary, modifier = Modifier.padding(top = 6.dp)) }
                if (call == "NEGOTIATE" && repair > 0) Text("A fair opening offer is the asking price minus the repairs you listed.", style = Wc.type.data.copy(fontWeight = FontWeight.Medium), color = c.text, modifier = Modifier.padding(top = 10.dp))
                if (call == "BUY") Text("Nothing measured is worn, and every shop check is ticked.", style = Wc.type.data, color = c.text, modifier = Modifier.padding(top = 10.dp))
            }
            Text("WorkCare has no price database, so it never says what a gadget is worth. It adds up what you tell it and what it measured.", style = Wc.type.meta, color = c.textSecondary, modifier = Modifier.padding(top = 10.dp))
        }
    }
}

// ------------------------------------------------------------------------------------------------------------ my gadgets (on the Scan tab)
@Composable fun MyGadgets(vm: AppVm, go: (String) -> Unit) {
    val list = vm.gadgets; if (list.isEmpty()) return
    SectionHeader("My gadgets")
    WcGroup { list.forEach { g -> ListRow(g.name, subtitle = g.kind.label + " · " + g.age.headline, onClick = { go(R.gadget(g.id)) }, chevron = true, leading = { IconBadge(if (g.kind == Kind.PHONE) WcIcons.Phone else WcIcons.Laptop, actionTint(g.verdict.action), 40.dp) }, trailing = { Text(g.verdict.action.short, style = Wc.type.meta.copy(fontWeight = FontWeight.Bold), color = actionTint(g.verdict.action)) }) } }
}
