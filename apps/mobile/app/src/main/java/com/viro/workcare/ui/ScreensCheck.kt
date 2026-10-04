package com.viro.workcare.ui

import android.content.Context
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.layout.heightIn
import android.hardware.camera2.CameraManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.runtime.DisposableEffect
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.border
import androidx.compose.foundation.BorderStroke
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.viro.workcare.AppVm
import com.viro.workcare.data.EvidenceType
import com.viro.workcare.data.Severity
import com.viro.workcare.pairing.ScanResult
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.sin

// ---------------------------------------------------------------------------------------------- Check tab
@Composable fun CheckScreen(vm: AppVm, go: (String) -> Unit) {
    val c = Wc.colors; val done = com.viro.workcare.ui.phoneTestsDone(vm)
    WithCta({ BottomCta("Scan this phone", "Health · security · storage") { go(R.SMART) } }) {
        Page(bottomPad = 110.dp) {
            Text("Scan", style = Wc.type.title, color = c.text, modifier = Modifier.padding(top = 8.dp, bottom = 14.dp))
            val big = androidx.compose.ui.platform.LocalDensity.current.fontScale > 1.25f
            val rep = vm.phoneReport
            val tiles: List<@Composable (Modifier) -> Unit> = listOf(
                { m -> ToolCard(WcIcons.Phone, "This phone", rep?.verdict?.action?.short ?: "…", rep?.verdict?.headline ?: "Reading", rep?.let { actionTint(it.verdict.action) } ?: c.green, m) { go(R.gadget(R.THIS_PHONE)) } },
                { m -> ToolCard(WcIcons.Laptop, "Computer", "PC", "Scan one with QuickCheck", c.green, m) { vm.endSession(); go(R.PAIR) } },
                { m -> ToolCard(WcIcons.Radar, "Lab", "${vm.lab.size} of ${com.viro.workcare.gadget.LabTest.entries.size + 6}", "Real tests: charger, storage, sensors, camera", c.green, m) { go(R.LAB) } },
                { m -> ToolCard(WcIcons.Check, "Deal check", if (vm.gadgets.isEmpty()) "Buying?" else "${vm.gadgets.size} gadgets", "Is the price right for what is worn?", c.green, m) { go(R.DEAL) } },
            )
            if (big) Column(verticalArrangement = Arrangement.spacedBy(12.dp)) { tiles.forEach { it(Modifier.fillMaxWidth()) } }
            else tiles.chunked(2).forEach { pair -> Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) { pair.forEach { t -> t(Modifier.weight(1f)) } } }
            MyGadgets(vm, go)
            SectionHeader("Scan a computer in three steps")
            WcCard {
                StepRow(1, "Open QuickCheck on the computer", "It runs without installing anything.")
                StepRow(2, "Choose Connect a phone", "A nine-digit code appears on its screen.")
                StepRow(3, "Type the code here", "The computer is found automatically.")
            }
            Text("A scan shows the state of a device now. It does not prove long-term reliability.", style = Wc.type.data, color = c.textSecondary, modifier = Modifier.padding(top = 14.dp))
        }
    }
}

fun phoneTestsDone(vm: AppVm): Int = listOf("screen", "touch", "vibration", "flash", "speaker", "charging").count { vm.phoneTests.containsKey(it) }

// ---------------------------------------------------------------------------------------------- Quick Connect and pairing
/** Nine digits in three groups. One hidden-text field underneath handles the keyboard, so paste, delete and the Done key all just work. */
@Composable private fun CodeBoxes(code: String, enabled: Boolean, focus: FocusRequester, onChange: (String) -> Unit, onDone: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    BasicTextField(code, { onChange(it.filter { c -> c.isDigit() }.take(9)) }, enabled = enabled, singleLine = true, cursorBrush = SolidColor(Color.Transparent),
        textStyle = TextStyle(color = Color.Transparent), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { onDone() }),
        modifier = Modifier.fillMaxWidth().focusRequester(focus).onFocusChanged { focused = it.isFocused },
        decorationBox = {
            Row(Modifier.fillMaxWidth().semantics { contentDescription = "Nine digit code, ${code.length} of 9 entered" }.clickable(indication = null, interactionSource = remember { MutableInteractionSource() }) { focus.requestFocus() }, verticalAlignment = Alignment.CenterVertically) {
                for (g in 0 until 3) {
                    Row(Modifier.weight(3f), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        for (i in 0 until 3) {
                            val idx = g * 3 + i; val here = idx == code.length && focused
                            Box(Modifier.weight(1f).heightIn(min = 60.dp).clip(RoundedCornerShape(10.dp)).background(Wc.colors.surface.copy(alpha = .85f)).border(BorderStroke(if (here) 2.dp else 1.dp, if (here) Wc.colors.green else if (idx < code.length) Wc.colors.green.copy(alpha = .35f) else Wc.colors.border), RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
                                Text(code.getOrNull(idx)?.toString() ?: "", style = Wc.type.numeral.copy(fontSize = 26.sp), color = Wc.colors.text)
                            }
                        }
                    }
                    if (g < 2) Box(Modifier.width(14.dp), contentAlignment = Alignment.Center) { Box(Modifier.width(6.dp).height(2.dp).background(Wc.colors.textSecondary.copy(alpha = .5f))) }
                }
            }
        })
}

@Composable fun PairScreen(vm: AppVm, back: () -> Unit, begin: () -> Unit) {
    var code by remember { mutableStateOf("") }; var manual by remember { mutableStateOf(false) }; var host by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    val s = vm.session
    // Search the moment the screen opens, and keep quietly looking while it stays open and nothing has answered.
    LaunchedEffect(Unit) { if (vm.session == null) vm.discover() }
    LaunchedEffect(vm.session) { while (vm.session == null) { delay(4000); if (!vm.searching && !vm.connecting && vm.found.isEmpty()) vm.discover(quiet = true) } }
    // Connect on its own: as soon as the ninth digit is in, and again when a computer appears while a full code is waiting.
    LaunchedEffect(code) { if (code.length == 9 && vm.session == null) vm.pair(code) { } }
    LaunchedEffect(vm.found) { if (code.length == 9 && vm.found.isNotEmpty() && vm.session == null && !vm.connecting && vm.sessionError == null) vm.pair(code) { } }
    LaunchedEffect(s == null) { if (s == null) { delay(250); try { focus.requestFocus() } catch (e: Exception) { } } }
    Page {
        TopBar(onBack = { vm.endSession(); back() })
        Spacer(Modifier.height(8.dp))
        if (s == null) {
            IconBadge(WcIcons.Laptop, Wc.colors.green, 52.dp)
            Text("Connect to a computer", style = Wc.type.hero, color = Wc.colors.text, modifier = Modifier.padding(top = 16.dp))
            Text("On the computer, open WorkCare QuickCheck, choose Connect a phone, then type the nine digits it shows.", style = Wc.type.body, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 10.dp, bottom = 24.dp))
            CodeBoxes(code, !vm.connecting, focus, { code = it; if (it.length < 9) vm.sessionError = null }, { if (code.length == 9) vm.pair(code) { } })
            Spacer(Modifier.height(18.dp))
            when {
                vm.connecting -> { SearchingBar(); Text("Connecting securely…", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 10.dp)) }
                vm.sessionError != null -> { Notice(vm.sessionError!!, Severity.CRITICAL); if (vm.sessionError!!.contains("not right")) Text("Check the nine digits against the computer's screen. The code changes when you press New code there.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 4.dp)) }
                vm.searching -> { SearchingBar(); Text("Looking for your computer on this network…", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 10.dp)) }
                vm.found.isNotEmpty() -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) { WcIcon(WcIcons.Tick, Wc.colors.green, 20.dp); Text(if (code.length == 9) "Computer found. Connecting…" else "Computer found on your network. Type the code to connect.", style = Wc.type.data, color = Wc.colors.text) }
                vm.searchedNothing -> {
                    WcCard(accent = Wc.colors.attention) {
                        Text("Your computer is not answering yet", style = Wc.type.section, color = Wc.colors.text)
                        Text("WorkCare keeps looking. Meanwhile, check these:", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 4.dp, bottom = 8.dp))
                        StepRow(1, "QuickCheck is open", "It must show a code, on its Connect a phone screen.")
                        StepRow(2, "Same network", "Put the phone on the computer's Wi-Fi, or join the computer to this phone's hotspot.")
                        StepRow(3, "Windows allowed it", "If Windows asked about QuickCheck and networks, choose Allow on private networks.")
                        Spacer(Modifier.height(10.dp)); SecondaryButton("Look again", { vm.discover() })
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
            if (vm.searchedNothing && !vm.connecting) {
                TextAction(if (manual) "Hide manual address" else "Still nothing? Enter the computer's address", { manual = !manual }, color = Wc.colors.textSecondary)
                if (manual) {
                    Text("QuickCheck shows its address on the same screen under Advanced.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(bottom = 10.dp))
                    WcField(host, { host = it.trim() }, "Computer address"); Spacer(Modifier.height(12.dp))
                    SecondaryButton("Connect to this address", { vm.connect(host, 47821, code) { } }, enabled = host.isNotBlank() && code.length == 9 && !vm.connecting)
                }
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) { IconBadge(WcIcons.Tick, Wc.colors.green, 48.dp); Text("Connected", style = Wc.type.hero, color = Wc.colors.text) }
            Text("Session secured. This connection can inspect the computer. It cannot change anything on it.", style = Wc.type.body, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 12.dp, bottom = 22.dp))
            WcCard(accent = Wc.colors.green) {
                Eyebrow("Check this matches the computer", color = Wc.colors.green)
                Text(s.sas.chunked(3).joinToString("  "), style = Wc.type.numeralLarge.copy(fontSize = 44.sp, letterSpacing = 2.sp), color = Wc.colors.text, modifier = Modifier.padding(top = 10.dp))
                Text("The same six digits must appear on the computer. If they differ, stop and start again.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 8.dp))
            }
            Spacer(Modifier.height(12.dp))
            WcGroup { KeyValueRow("Connection", "Private local network"); KeyValueRow("Session", "Encrypted, expires automatically") }
            Spacer(Modifier.height(22.dp))
            PrimaryButton("Begin inspection", { vm.beginInspection(); begin() })
        }
    }
}

@Composable private fun SearchingBar() {
    val t = rememberInfiniteTransition(label = "search"); val xAnim by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1300, easing = LinearEasing), RepeatMode.Restart), label = "x"); val x = if (reduceMotion()) .35f else xAnim
    Box(Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(Wc.colors.border.copy(alpha = .18f))) {
        androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth().height(4.dp)) { Box(Modifier.width(maxWidth * .3f).height(4.dp).offset(x = (maxWidth * .7f) * x).clip(RoundedCornerShape(2.dp)).background(Wc.colors.green)) }
    }
}

@Composable fun Spinner(size: Dp = 20.dp) {
    val t = rememberInfiniteTransition(label = "spin"); val aAnim by t.animateFloat(0f, 360f, infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart), label = "a"); val a = if (reduceMotion()) 90f else aAnim; val c = Wc.colors.green; val track = Wc.colors.border
    androidx.compose.foundation.Canvas(Modifier.size(size)) { val sw = 2.4.dp.toPx(); drawCircle(track.copy(alpha = .2f), radius = (this.size.minDimension - sw) / 2, style = androidx.compose.ui.graphics.drawscope.Stroke(sw)); drawArc(c, a, 100f, false, androidx.compose.ui.geometry.Offset(sw / 2, sw / 2), androidx.compose.ui.geometry.Size(this.size.width - sw, this.size.height - sw), style = androidx.compose.ui.graphics.drawscope.Stroke(sw, cap = androidx.compose.ui.graphics.StrokeCap.Round)) }
}

// ---------------------------------------------------------------------------------------------- scan progress and results
@Composable fun ScanScreen(vm: AppVm, back: () -> Unit, done: () -> Unit) {
    val p = vm.progress; val r = vm.result
    LaunchedEffect(r) { if (r != null) done() }
    Page {
        TopBar(onBack = { vm.endSession(); back() })
        Text(p?.deviceName?.let { "Checking $it" } ?: "Checking this computer", style = Wc.type.title, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp, bottom = 16.dp))
        val (mk, md) = makerModel(p?.deviceModel)
        val photo = rememberDevicePhoto(vm, "pc-" + (p?.deviceName ?: "unknown"), mk, md, false)
        ScanPanel(photo, done = r != null, completed = p?.completed ?: 0, total = p?.total, current = p?.stages?.firstOrNull { it.state == "running" }?.label, name = p?.deviceName)
        Spacer(Modifier.height(16.dp))
        if (p == null) Text("Waiting for the computer to start.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(vertical = 8.dp))
        else WcGroup {
            p.stages.forEach { s ->
                ListRow(s.label, subtitle = s.detail, leading = {
                    Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) {
                        when (s.state) { "done" -> WcIcon(WcIcons.Tick, Wc.colors.green, 22.dp); "running" -> Spinner(22.dp); "failed" -> Box(Modifier.size(10.dp).clip(CircleShape).background(Wc.colors.attention)); else -> Box(Modifier.size(8.dp).clip(CircleShape).background(Wc.colors.border.copy(alpha = .35f))) }
                    }
                }, trailing = {
                    when (s.state) {
                        "done" -> Text("Done", style = Wc.type.data, color = Wc.colors.textSecondary)
                        "running" -> Text("Checking", style = Wc.type.data.copy(fontWeight = FontWeight.Medium), color = Wc.colors.text)
                        "failed" -> Text("Could not read", style = Wc.type.data, color = Wc.colors.attention)
                        "skipped" -> Text("Skipped", style = Wc.type.data, color = Wc.colors.textSecondary)
                        else -> Text("Waiting", style = Wc.type.data, color = Wc.colors.textSecondary)
                    }
                })
            }
        }
        vm.sessionError?.let { Notice(it, Severity.CRITICAL, Modifier.padding(top = 10.dp)); Spacer(Modifier.height(10.dp)); SecondaryButton("Close", { vm.endSession(); back() }) }
        if (vm.sessionError == null) Text("You can keep the phone connected. Nothing on the computer is being changed.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 16.dp))
    }
}

@Composable fun ResultsScreen(vm: AppVm, openPlus: () -> Unit, openReport: (String) -> Unit, finish: () -> Unit) {
    // The finished check is held here while the page closes, and cleared only after leaving: clearing it first made this page flash "No result yet".
    val r = remember { vm.result }
    LaunchedEffect(r) { if (r == null) finish() }
    val saved = remember(r) { r?.let { vm.saveScanAsGadget(it) } }
    val leave = { finish(); vm.endSession() }
    if (r == null) { Page { }; return }
    val tone = if (r.critical > 0) Wc.colors.critical else if (r.attention > 0) Wc.colors.attention else Wc.colors.green
    Page {
        TopBar(onBack = leave)
        Eyebrow("Check complete", color = Wc.colors.green)
        Text(r.deviceName, style = Wc.type.title, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp))
        r.deviceModel?.let { Text(it, style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 2.dp)) }
        Spacer(Modifier.height(16.dp))
        run {
            val (mk, md) = makerModel(r.deviceModel); val key = "pc-" + r.deviceName
            val photo = rememberDevicePhoto(vm, key, mk, md, false); val pick = rememberPhotoPicker(vm, key)
            DeviceBanner(photo, onChange = pick); Spacer(Modifier.height(14.dp))
        }
        WcCard(accent = tone) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                HealthRing(r.passed, r.attention, r.critical, size = 88.dp) { Text("${r.passed + r.attention + r.critical}", style = Wc.type.numeral, color = Wc.colors.text) }
                Spacer(Modifier.width(18.dp))
                Column(Modifier.weight(1f)) {
                    Text(if (r.critical > 0) "Serious problems found" else if (r.attention > 0) "Mostly fine, with things to know" else "No problems found", style = Wc.type.section, color = Wc.colors.text)
                    Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(22.dp)) {
                        Numeral("${r.passed}", "passed"); if (r.attention > 0) Numeral("${r.attention}", "attention", color = Wc.colors.attention); if (r.critical > 0) Numeral("${r.critical}", "critical", color = Wc.colors.critical)
                    }
                }
            }
        }
        val bad = r.findings.filter { it.severity != Severity.HEALTHY }.sortedByDescending { it.severity.ordinal }; val good = r.findings.filter { it.severity == Severity.HEALTHY }
        if (bad.isNotEmpty()) { SectionHeader("Needs attention"); bad.forEach { FindingBlock(it) } }
        if (r.depth == "deep") {
            val deepAll = r.findings.filter { it.tier == com.viro.workcare.data.Tier.DEEP }
            SectionHeader("Deep audit")
            WcCard(accent = Wc.colors.green) { Eyebrow("Plus", color = Wc.colors.green); Text(if (deepAll.none { it.severity != Severity.HEALTHY }) "Deeper checks found nothing to act on" else "${deepAll.count { it.severity != Severity.HEALTHY }} of ${deepAll.size} deeper checks need a look", style = Wc.type.section, color = Wc.colors.text, modifier = Modifier.padding(top = 6.dp)); Text("Their findings are marked DEEP above and below. Anything that could not be read is listed under Not measured.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 4.dp)) }
        } else if (r.deepNotRun.isNotEmpty()) PcDeepLocked(vm, r.deepNotRun, openPlus)
        if (good.isNotEmpty()) { SectionHeader("Good"); WcGroup { good.forEach { f -> ListRow(f.title, subtitle = f.summary, leading = { IconBadge(WcIcons.Tick, Wc.colors.green, 36.dp) }, trailing = { EvidenceTag(f.type) }) } } }
        if (r.notMeasured.isNotEmpty()) { SectionHeader("Not measured"); r.notMeasured.take(8).forEach { Text(it, style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(vertical = 3.dp)) } }
        Text(r.disclaimer, style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 22.dp, bottom = 18.dp))
        if (saved != null) { PrimaryButton("Full report: age, wear, verdict", { openReport(saved.id) }); Spacer(Modifier.height(10.dp)) }
        SecondaryButton("Done", leave)
    }
}

// ---------------------------------------------------------------------------------------------- phone hardware tests (real hardware APIs; results are labelled TESTED)
private enum class PTest(val id: String, val title: String, val hint: String) {
    SCREEN("screen", "Screen", "Look for dead pixels, lines and colour tint"), TOUCH("touch", "Touch", "Every square must respond"), VIBRATION("vibration", "Vibration", "Feel for the motor"),
    FLASH("flash", "Flash", "The torch lights for two seconds"), SPEAKER("speaker", "Speaker", "A tone plays for one second"), CHARGING("charging", "Charging", "Plug in a charger"),
}

@Composable fun PhoneTestsScreen(vm: AppVm, back: () -> Unit) {
    var active by remember { mutableStateOf<PTest?>(null) }
    val ctx = LocalContext.current
    val pm = ctx.packageManager
    fun has(f: String) = pm.hasSystemFeature(f)
    Page {
        TopBar(onBack = back)
        Eyebrow("Phone check", color = Wc.colors.green)
        Text("Test this phone.", style = Wc.type.hero, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp))
        val done = PTest.entries.count { vm.phoneTests.containsKey(it.id) }; val fails = PTest.entries.count { vm.phoneTests[it.id] == false }
        Text("$done of ${PTest.entries.size} tests done" + if (fails > 0) " · $fails need a look" else "", style = Wc.type.body, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 8.dp, bottom = 12.dp))
        Spacer(Modifier.height(4.dp))
        WcGroup { PTest.entries.forEach { t ->
            val r = vm.phoneTests[t.id]
            ListRow(t.title, subtitle = t.hint, onClick = { active = t }, chevron = r == null, leading = { IconBadge(when (t) { PTest.SCREEN -> WcIcons.Phone; PTest.TOUCH -> WcIcons.Plus; PTest.CHARGING -> WcIcons.Home; else -> WcIcons.Check }, if (r == false) Wc.colors.attention else Wc.colors.green, 40.dp) }, trailing = { when (r) { true -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) { WcIcon(WcIcons.Tick, Wc.colors.green, 20.dp); EvidenceTag(EvidenceType.TESTED) }; false -> StatusPill(Severity.ATTENTION, "Check"); null -> {} } })
        } }
        SectionHeader("Present on this phone")
        Text("These show what the hardware reports. They are not tested.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(bottom = 10.dp))
        WcGroup { listOf("Wi-Fi" to "android.hardware.wifi", "Bluetooth" to "android.hardware.bluetooth", "GPS" to "android.hardware.location.gps", "Fingerprint" to "android.hardware.fingerprint", "Camera" to "android.hardware.camera", "Flash" to "android.hardware.camera.flash", "NFC" to "android.hardware.nfc", "Gyroscope" to "android.hardware.sensor.gyroscope")
            .forEach { (label, feature) -> KeyValueRow(label, if (has(feature)) "Present" else "Not available on this device") }
        vm.phone?.let { KeyValueRow("Sensors listed by Android", "${it.sensorCount ?: 0}") } }
        Spacer(Modifier.height(20.dp))
        PrimaryButton("Done", { vm.addHistory("Phone hardware tests", "$done of ${PTest.entries.size} done"); back() }, enabled = done > 0)
        Text("Camera, microphone, earpiece and button tests are not included in this version.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 12.dp))
    }
    active?.let { t -> PhoneTestRunner(t, vm) { active = null } }
}

@Composable private fun PhoneTestRunner(t: PTest, vm: AppVm, close: () -> Unit) {
    val ctx = LocalContext.current
    when (t) {
        PTest.SCREEN -> ScreenColors { ok -> vm.recordPhoneTest("screen", ok); close() }
        PTest.TOUCH -> TouchGrid { vm.recordPhoneTest("touch", true); close() }
        PTest.VIBRATION -> { LaunchedEffect(Unit) { vibrate(ctx) }; AskSheet("Did you feel the phone vibrate?", { vm.recordPhoneTest("vibration", it); close() }, again = { vibrate(ctx) }) }
        PTest.FLASH -> { LaunchedEffect(Unit) { torch(ctx) }; AskSheet("Did the flash light up?", { vm.recordPhoneTest("flash", it); close() }, again = { }) }
        PTest.SPEAKER -> { LaunchedEffect(Unit) { tone() }; AskSheet("Did you hear a tone from the speaker?", { vm.recordPhoneTest("speaker", it); close() }, again = { }) }
        PTest.CHARGING -> { vm.readPhone(); val ok = vm.phone?.plugged != null; AskSheet(if (ok) "A charger is detected (${vm.phone?.plugged}). Is the phone charging?" else "No charger detected. Plug one in, then check again.", { vm.recordPhoneTest("charging", ok && it); close() }, again = { vm.readPhone() }) }
    }
}

@Composable private fun AskSheet(question: String, answer: (Boolean) -> Unit, again: () -> Unit) {
    WcSheet({ answer(false) }) {
        Text(question, style = Wc.type.section, color = Wc.colors.text, modifier = Modifier.padding(top = 6.dp, bottom = 18.dp))
        PrimaryButton("Yes", { answer(true) }); Spacer(Modifier.height(10.dp)); SecondaryButton("No", { answer(false) }); TextAction("Test again", again, color = Wc.colors.textSecondary)
    }
}

@Composable private fun ScreenColors(result: (Boolean) -> Unit) {
    val colors = listOf(Color.Red, Color.Green, Color.Blue, Color.White, Color.Black); var i by remember { mutableIntStateOf(0) }; var ask by remember { mutableStateOf(false) }
    if (!ask) Box(Modifier.fillMaxSize().background(colors[i]).clickable { if (i < colors.lastIndex) i++ else ask = true }, contentAlignment = Alignment.BottomCenter) {
        Text("Tap to change colour (${i + 1} of ${colors.size})", style = Wc.type.data, color = if (i == 3) Color.Black else Color.White, modifier = Modifier.statusBarsPadding().padding(bottom = 40.dp))
    } else AskSheet("Did every colour look even, with no dead pixels or lines?", result, again = { i = 0; ask = false })
}

@Composable private fun TouchGrid(done: () -> Unit) {
    val hit = remember { androidx.compose.runtime.mutableStateListOf<Int>() }
    LaunchedEffect(hit.size) { if (hit.size == 12) { delay(400); done() } }
    Box(Modifier.fillMaxSize().background(Wc.colors.bg).statusBarsPadding().padding(Wc.gutter)) {
        Column {
            Text("Tap every square.", style = Wc.type.title, color = Wc.colors.text); Text("${hit.size} of 12", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 4.dp, bottom = 16.dp))
            for (row in 0 until 4) Row(Modifier.weight(1f).padding(bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) { for (col in 0 until 3) { val n = row * 3 + col; Box(Modifier.weight(1f).fillMaxSize().clip(RoundedCornerShape(8.dp)).background(if (n in hit) Wc.colors.green else Wc.colors.surface).clickable { if (n !in hit) hit.add(n) }) } }
        }
    }
}

private fun vibrate(ctx: Context) { val v = ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator; if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(600, VibrationEffect.DEFAULT_AMPLITUDE)) else @Suppress("DEPRECATION") v.vibrate(600) }
private suspend fun torch(ctx: Context) {
    val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    val id = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(android.hardware.camera2.CameraCharacteristics.FLASH_INFO_AVAILABLE) == true } ?: return
    try { cm.setTorchMode(id, true); delay(2000) } finally { try { cm.setTorchMode(id, false) } catch (e: Exception) { } }
}
private suspend fun tone() {
    val rate = 22050; val n = rate; val data = ShortArray(n) { (sin(2 * PI * 440 * it / rate) * 9000).toInt().toShort() }
    val t = AudioTrack.Builder().setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build()).setBufferSizeInBytes(n * 2).setTransferMode(AudioTrack.MODE_STATIC).build()
    try { t.write(data, 0, n); t.play(); delay(1100) } finally { t.release() }
}

/** After a free scan of a computer: the deep checks that did not run, by name, and a plain statement that nothing is known about them. */
@Composable fun PcDeepLocked(vm: AppVm, checks: List<com.viro.workcare.phone.DeepCheck>, openPlus: () -> Unit) {
    SectionHeader("Deeper checks")
    WcCard {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) { WcIcon(WcIcons.Lock, Wc.colors.green, 18.dp); Eyebrow("Deep audit · WorkCare Plus", color = Wc.colors.green) }
        Text("${checks.size} deeper checks were not run", style = Wc.type.section, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp))
        Text("The free scan shows the drive, battery, memory, heat and protection basics, and always shows a safety problem it finds. These look further. They have not been run, so WorkCare cannot say whether anything is wrong.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 6.dp, bottom = 8.dp))
        checks.forEach { c -> Column(Modifier.padding(vertical = 6.dp)) { Row(verticalAlignment = Alignment.Top) { WcIcon(WcIcons.Lock, Wc.colors.textSecondary, 14.dp, Modifier.padding(top = 3.dp)); Spacer(Modifier.width(10.dp)); Column { Text(c.title, style = Wc.type.bodyStrong, color = Wc.colors.text); Text(c.why, style = Wc.type.data, color = Wc.colors.textSecondary) } } } }
        Spacer(Modifier.height(12.dp))
        PrimaryButton("See what Plus includes", { openPlus() })
    }
}
