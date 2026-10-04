package com.viro.workcare.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.viro.workcare.AppVm
import com.viro.workcare.BuildConfig
import com.viro.workcare.data.Severity
import com.viro.workcare.rescue.RescueOutcome
import com.viro.workcare.rescue.RescueRules
import com.viro.workcare.rescue.Symptom
import kotlinx.coroutines.delay

// ---------------------------------------------------------------------------------------------- Rescue
@Composable fun RescueScreen(vm: AppVm, go: (String) -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val targets = buildList { vm.phone?.let { add(R.THIS_PHONE to "This phone") }; vm.devices.forEach { add(it.id to it.name) } }
    var target by remember { mutableStateOf(targets.firstOrNull()?.first ?: R.THIS_PHONE) }
    var pick by remember { mutableStateOf(false) }
    val found = vm.phoneHealth?.findings.orEmpty().filter { it.severity != Severity.HEALTHY }.sortedByDescending { it.severity.ordinal }
    Page {
        Text("Fix", style = Wc.type.title, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp, bottom = 12.dp))
        StatusBanner("THIS PHONE HAS", if (found.isEmpty()) "NOTHING TO FIX" else "${found.size} TO FIX", if (found.isEmpty()) Wc.colors.green else Wc.colors.status(found.first().severity))
        SectionHeader("Found on this phone")
        if (found.isEmpty()) WcCard { Text("No problems found", style = Wc.type.section, color = Wc.colors.text); Text("Scan again after you change something.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 4.dp)) }
        else found.forEach { f ->
            val act = Fixes.forFinding(f)
            WcCard(accent = Wc.colors.status(f.severity), padding = 16.dp) {
                Row(verticalAlignment = Alignment.CenterVertically) { StatusDot(f.severity, 10.dp); Spacer(Modifier.width(10.dp)); Text(f.title, style = Wc.type.bodyStrong.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), color = Wc.colors.text, modifier = Modifier.weight(1f)); EvidenceTag(f.type) }
                Text(f.summary, style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 6.dp))
                if (f.action != null && act == null) Text(f.action, style = Wc.type.data, color = Wc.colors.text, modifier = Modifier.padding(top = 6.dp))
                if (act != null) { Spacer(Modifier.height(12.dp)); PrimaryButton(act.label, { runFix(ctx, act, go) }) }
            }
            Spacer(Modifier.height(10.dp))
        }
        SectionHeader("Tools")
        WcGroup {
            ListRow("Clean storage", subtitle = "Delete hidden and leftover files for good", onClick = { go(R.CLEAN) }, chevron = true, leading = { IconBadge(WcIcons.Clean, Wc.colors.green, 40.dp) })
            ListRow("Check for system updates", subtitle = "Security patches and Android updates", onClick = { Fixes.open(ctx, "android.settings.SYSTEM_UPDATE_SETTINGS") }, chevron = true, leading = { IconBadge(WcIcons.Fix, Wc.colors.green, 40.dp) })
            ListRow("What uses the battery", subtitle = "Open Android's battery usage", onClick = { Fixes.open(ctx, Intent.ACTION_POWER_USAGE_SUMMARY) }, chevron = true, leading = { IconBadge(WcIcons.Fix, Wc.colors.green, 40.dp) })
            ListRow("Uninstall apps", subtitle = "Open the app list, largest first", onClick = { Fixes.open(ctx, android.provider.Settings.ACTION_MANAGE_ALL_APPLICATIONS_SETTINGS) }, chevron = true, leading = { IconBadge(WcIcons.Fix, Wc.colors.green, 40.dp) })
            ListRow("Review who has access", subtitle = "Accessibility, notifications, files, accounts", onClick = { go(R.CLEAN) }, chevron = true, leading = { IconBadge(WcIcons.Check, Wc.colors.green, 40.dp) })
        }
        SectionHeader("Describe a problem")
        if (targets.size > 1) { WcGroup { ListRow("On", subtitle = targets.firstOrNull { it.first == target }?.second, onClick = { pick = true }, chevron = true) }; Spacer(Modifier.height(10.dp)) }
        WcGroup { Symptom.entries.forEach { s -> ListRow(s.label, onClick = { go(R.rescue(target, s.name)) }, chevron = true) } }
    }
    if (pick) WcSheet({ pick = false }) {
        Text("Which device?", style = Wc.type.section, color = Wc.colors.text, modifier = Modifier.padding(top = 4.dp, bottom = 6.dp)); Hairline()
        targets.forEach { (id, n) -> ListRow(n, onClick = { target = id; pick = false }, trailing = { if (id == target) WcIcon(WcIcons.Tick, Wc.colors.green, 20.dp) }) }
    }
}

/** Rescue investigation + result. The evidence is read fresh, the rules select what explains the symptom, and nothing is invented. */
@Composable fun RescueResultScreen(vm: AppVm, id: String, symptomName: String, back: () -> Unit, go: (String) -> Unit) {
    val symptom = Symptom.entries.firstOrNull { it.name == symptomName } ?: Symptom.OTHER
    var phase by remember { mutableStateOf(0) }
    var outcome by remember { mutableStateOf<RescueOutcome?>(null) }
    var msg by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(id, symptomName) {
        phase = 0
        if (id == R.THIS_PHONE) vm.readPhone() else vm.loadDeviceNow(id)
        phase = 1; delay(250)
        val h = if (id == R.THIS_PHONE) vm.phoneHealth else vm.healthCache[id]
        outcome = if (h == null) null else RescueRules.evaluate(symptom, h); phase = 2
    }
    Page {
        TopBar(onBack = back)
        Eyebrow(symptom.label, color = Wc.colors.green)
        val o = outcome
        if (phase < 2) {
            Text("Collecting evidence.", style = Wc.type.hero, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp))
            Text(if (phase == 0) "Reading the device's current measurements." else "Comparing them with the WorkCare rules.", style = Wc.type.body, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 10.dp))
        } else if (o == null) {
            Text("Could not read this device.", style = Wc.type.hero, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp))
            Notice("WorkCare could not get a current reading. Check the connection and try again.")
            SecondaryButton("Try again", { vm.loadDevice(id); go(R.rescue(id, symptomName)) })
        } else {
            Text(if (o.causeFound) "Cause found" else if (o.honestLimit != null) "Cannot tell yet" else "No clear cause", style = Wc.type.eyebrow, color = if (o.causeFound) Wc.colors.attention else Wc.colors.textSecondary, modifier = Modifier.padding(top = 10.dp))
            Text(o.title, style = Wc.type.title, color = Wc.colors.text, modifier = Modifier.padding(top = 6.dp))
            Text(o.explanation, style = Wc.type.body, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 10.dp, bottom = 4.dp))
            if (o.evidence.isNotEmpty()) { SectionHeader("Evidence"); o.finding?.let { Row(Modifier.padding(bottom = 4.dp)) { EvidenceTag(it.type) } }; WcGroup { o.evidence.forEach { KeyValueRow(prettyName(it.name), it.value, it.unit) } } }
            if (o.steps.isNotEmpty()) { SectionHeader("What to do"); WcCard { o.steps.forEachIndexed { i, t -> StepRow(i + 1, t) } } }
            if (o.ruledOut.isNotEmpty()) { SectionHeader("Looks fine"); o.ruledOut.forEach { Text(it, style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(vertical = 3.dp)) } }
            if (o.notMeasured.isNotEmpty()) { SectionHeader("Not measured"); o.notMeasured.take(5).forEach { Text(it, style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(vertical = 3.dp)) } }
            Spacer(Modifier.height(22.dp))
            o.finding?.let { f -> Fixes.forFinding(f) }?.let { a -> val ctx = androidx.compose.ui.platform.LocalContext.current; PrimaryButton(a.label, { runFix(ctx, a, go) }); Spacer(Modifier.height(10.dp)) }
            if (id != R.THIS_PHONE && !o.causeFound) { SecondaryButton("Run a deeper hardware test", { vm.runTest(id, "hardware") { msg = it ?: "Test requested. Check again when the computer has reported." } }); msg?.let { Notice(it, Severity.HEALTHY, Modifier.padding(top = 8.dp)) }; Spacer(Modifier.height(10.dp)) }
            PrimaryButton("Done", { vm.addHistory("Rescue: ${symptom.label}", o.title); back() })
        }
    }
}

// ---------------------------------------------------------------------------------------------- alerts, passport, compute
@Composable fun AlertsScreen(vm: AppVm, back: () -> Unit, go: (String) -> Unit) {
    Page {
        TopBar(onBack = back)
        Text("Alerts", style = Wc.type.title, color = Wc.colors.text, modifier = Modifier.padding(top = 6.dp))
        Text("Only things that need you. Healthy devices stay quiet.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 4.dp, bottom = 12.dp))
        if (vm.alerts.isEmpty()) { EmptyState(WcIcons.Bell, "No open alerts", if (vm.signedIn) "Nothing needs your attention. WorkCare tells you here when something does." else "Sign in to see alerts for your computers.") }
        else WcGroup { vm.alerts.forEach { a -> ListRow(a.title, subtitle = a.summary, onClick = { go(R.device(a.deviceId)) }, leading = { IconBadge(WcIcons.Bell, Wc.colors.status(a.severity), 40.dp) }, trailing = { StatusPill(a.severity) }, chevron = true) } }
    }
}

@Composable fun PassportScreen(vm: AppVm, id: String, back: () -> Unit) {
    LaunchedEffect(id) { vm.loadPassport(id) }
    val name = vm.devices.firstOrNull { it.id == id }?.name ?: "Device"
    Page {
        TopBar(onBack = back)
        Eyebrow("Machine passport", color = Wc.colors.green)
        Text(name, style = Wc.type.title, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp, bottom = 18.dp))
        val ev = vm.passport[id]
        if (ev == null) Text("Loading.", style = Wc.type.data, color = Wc.colors.textSecondary)
        else if (ev.isEmpty()) Text("No events recorded yet.", style = Wc.type.data, color = Wc.colors.textSecondary)
        ev?.forEach { e ->
            Row(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
                Column(Modifier.padding(end = 16.dp)) { Text(dateTimeText(e.at).substringBefore(" ·").uppercase(), style = Wc.type.eyebrow, color = Wc.colors.textSecondary) }
                Column(Modifier) { Text(e.title, style = Wc.type.bodyStrong, color = Wc.colors.text); e.detail?.let { Text(it, style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 2.dp)) } }
            }
            Hairline(Modifier.padding(vertical = 8.dp))
        }
        Text("Every entry comes from something WorkCare recorded: installation, a baseline reading, a service record or a verified repair.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 10.dp))
    }
}

@Composable fun ComputeScreen(vm: AppVm, id: String, back: () -> Unit) {
    LaunchedEffect(id) { vm.loadCompute(id) }
    val c = vm.compute[id]; var sheet by remember { mutableStateOf(false) }; var err by remember { mutableStateOf<String?>(null) }
    val name = vm.devices.firstOrNull { it.id == id }?.name ?: "Device"
    Page {
        TopBar(onBack = back)
        Eyebrow("Compute", color = Wc.colors.textSecondary)
        Text(name, style = Wc.type.title, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp))
        Text("Compute is optional and runs only on a computer your organization has enabled. This phone never runs it. Health always comes first.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 6.dp, bottom = 14.dp))
        if (c == null) Text("Loading.", style = Wc.type.data, color = Wc.colors.textSecondary)
        else if (!c.available) { WcGroup { KeyValueRow("Status", "Not enabled for this computer") } }
        else {
            WcGroup {
            KeyValueRow("Status", c.state?.replace('-', ' ')?.replaceFirstChar { it.uppercase() } ?: "Not reporting")
            c.reason?.let { KeyValueRow("Why", it) }
            KeyValueRow("Health gate", when (c.gate) { "ALLOW" -> "Allowed"; "THROTTLE" -> "Reduced"; "PAUSE" -> "Paused by health"; "BLOCK" -> "Blocked by health"; else -> "Unknown" })
            c.cpuTempC?.let { KeyValueRow("CPU temperature", "${it.toInt()}", "°C") }
            c.cpuCapPercent?.let { KeyValueRow("CPU limit", "${it.toInt()}", "%") }
            KeyValueRow("Consent recorded", if (c.consentRecorded) "Yes" else "No") }
            Spacer(Modifier.height(20.dp))
            if (c.canPause) PrimaryButton("Pause", { sheet = true }) else if (c.canResume) PrimaryButton("Resume", { vm.resumeCompute(id) { err = it } })
            err?.let { Notice(it, Severity.CRITICAL, Modifier.padding(top = 10.dp)) }
            if (!c.canPause && !c.canResume) Text("Only an administrator can pause or resume. Resume never switches compute on by itself.", style = Wc.type.data, color = Wc.colors.textSecondary)
        }
    }
    if (sheet) WcSheet({ sheet = false }) {
        Text("Pause for how long?", style = Wc.type.section, color = Wc.colors.text, modifier = Modifier.padding(top = 4.dp, bottom = 6.dp)); Hairline()
        listOf(60 to "1 hour", 240 to "4 hours", 1440 to "Until tomorrow").forEach { (m, l) -> ListRow(l, onClick = { sheet = false; vm.pauseCompute(id, m) { err = it } }) }
    }
}

// ---------------------------------------------------------------------------------------------- You
@Composable fun YouScreen(vm: AppVm, go: (String) -> Unit) {
    Page {
        Spacer(Modifier.height(8.dp)); Text("You", style = Wc.type.title, color = Wc.colors.text)
        Spacer(Modifier.height(14.dp))
        WcCard(accent = if (vm.signedIn) Wc.colors.green else null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconBadge(WcIcons.You, Wc.colors.green, 52.dp); Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) { Text(if (vm.signedIn) (vm.email ?: "Signed in") else "Not signed in", style = Wc.type.bodyStrong.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), color = Wc.colors.text, maxLines = 1); Text(if (vm.signedIn) "WorkCare account" else "Sign in to see your organization's computers", style = Wc.type.data, color = Wc.colors.textSecondary) }
            }
            Spacer(Modifier.height(16.dp))
            if (vm.signedIn) SecondaryButton("Sign out", { vm.logout() }) else PrimaryButton("Sign in", { go(R.LOGIN) })
        }
        SectionHeader("Plan")
        WcGroup { ListRow(if (vm.plus) "WorkCare Plus" else "Free", subtitle = vm.plusSource ?: "Essential checks, daily check, 7-day history", onClick = { go(R.PLUS) }, chevron = true, leading = { IconBadge(WcIcons.Lock, Wc.colors.green, 40.dp) }, trailing = { if (vm.plus) StatusPill(Severity.HEALTHY, "Active") }) }
        SectionHeader("App")
        WcGroup {
            ListRow("Appearance", subtitle = when (vm.themeMode) { "dark" -> "Dark"; "light" -> "Light"; else -> "Follows the system" }, onClick = { go(R.SETTINGS) }, chevron = true)
            ListRow("Permissions", subtitle = "What WorkCare asks for, and why", onClick = { go(R.PERMISSIONS) }, chevron = true)
            ListRow("Server", subtitle = vm.server, onClick = { go(R.SETTINGS) }, chevron = true)
        }
        SectionHeader("About")
        WcGroup { KeyValueRow("Version", BuildConfig.VERSION_NAME); KeyValueRow("Compute", "None. This app never mines."); ListRow("Photo credits", subtitle = "The photographers behind the pictures", onClick = { go(R.CREDITS) }, chevron = true) }
    }
}

@Composable fun SettingsScreen(vm: AppVm, back: () -> Unit) {
    var url by remember { mutableStateOf(vm.server) }; var err by remember { mutableStateOf<String?>(null) }
    Page {
        TopBar(onBack = back)
        Text("Settings", style = Wc.type.title, color = Wc.colors.text, modifier = Modifier.padding(top = 6.dp))
        SectionHeader("Appearance")
        WcGroup { listOf("system" to "Follow the system", "dark" to "Dark", "light" to "Light").forEach { (k, l) -> ListRow(l, onClick = { vm.setTheme(k) }, trailing = { if (vm.themeMode == k) WcIcon(WcIcons.Tick, Wc.colors.green, 20.dp) }) } }
        SectionHeader("Pictures of your devices")
        WcGroup {
            ListRow("Look up a photo of the exact model", subtitle = "Sends only the maker and model name (for example HP ProBook 430 G7) to Wikimedia Commons. Off means no lookup: a representative photo or your own is used.", onClick = { vm.enablePhotoLookup(!vm.photoLookup) },
                trailing = { if (vm.photoLookup) WcIcon(WcIcons.Tick, Wc.colors.green, 20.dp) else Text("Off", style = Wc.type.data, color = Wc.colors.textSecondary) })
        }
        SectionHeader("Server")
        Text("The WorkCare Control address. Most people never change this.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(bottom = 10.dp))
        WcField(url, { url = it }, "Address"); err?.let { Notice(it, Severity.CRITICAL, Modifier.padding(top = 8.dp)) }
        Spacer(Modifier.height(14.dp)); SecondaryButton("Save address", { err = vm.setServer(url) ?: run { vm.refresh(); null } })
    }
}

@Composable fun PermissionsScreen(back: () -> Unit) {
    Page {
        TopBar(onBack = back)
        Text("Permissions", style = Wc.type.title, color = Wc.colors.text, modifier = Modifier.padding(top = 6.dp))
        Text("WorkCare asks only when you use a feature that needs something, and tells you why first.", style = Wc.type.body, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 8.dp, bottom = 16.dp))
        WcGroup {
            KeyValueRow("Needed to install", "None beyond internet access")
            KeyValueRow("Phone hardware tests", "Vibration and flash use no permission")
            KeyValueRow("Finding a computer", "Local network, no permission prompt")
            KeyValueRow("Device photos", "Optional online lookup; your own photos stay on this phone")
        }
        Text("Camera (QR pairing), notifications and Nearby devices are not requested in this version because those features are not in it yet.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 14.dp))
    }
}

// ---------------------------------------------------------------------------------------------- photo credits
@Composable fun CreditsScreen(back: () -> Unit) {
    Page {
        TopBar(onBack = back)
        Text("Photo credits", style = Wc.type.title, color = Wc.colors.text, modifier = Modifier.padding(top = 6.dp))
        Text("The pictures in this app are free to use under the Unsplash licence. Thank you to the photographers. Photos of a specific device that appear on a device screen come from Wikimedia Commons (credited under the picture) or from you.", style = Wc.type.body, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 8.dp, bottom = 16.dp))
        WcGroup {
            listOf("Martin Sanchez" to "Laptop photograph", "The Average Tech Guy" to "Phone photograph", "Chris Ried" to "Circuit board photograph", "Doon _MUC" to "Green room photograph")
                .forEach { (who, what) -> KeyValueRow(what, who) }
        }
    }
}
