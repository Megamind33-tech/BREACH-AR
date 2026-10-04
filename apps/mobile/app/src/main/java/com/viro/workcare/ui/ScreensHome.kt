package com.viro.workcare.ui

import com.viro.workcare.phone.displayName
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.layout.heightIn
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.draw.drawBehind
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.border
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.TextStyle
import com.viro.workcare.AppVm
import com.viro.workcare.data.ComponentHealth
import com.viro.workcare.data.DeviceHealth
import com.viro.workcare.data.DeviceSummary
import com.viro.workcare.data.Finding
import com.viro.workcare.data.Freshness
import com.viro.workcare.data.Severity

object R {
    const val ONBOARDING = "onboarding"; const val FIRST = "first"; const val LOGIN = "login"
    const val HOME = "home"; const val DEVICES = "devices"; const val CHECK = "check"; const val RESCUE = "rescue"; const val YOU = "you"
    const val THIS_PHONE = "this-phone"; const val ALERTS = "alerts"; const val PAIR = "pair"; const val SCAN = "scan"; const val RESULTS = "results"; const val PHONE_TESTS = "phonetests"
    const val SETTINGS = "settings"; const val PERMISSIONS = "permissions"; const val CREDITS = "credits"; const val PLUS = "plus"; const val TRENDS = "trends"; const val CLEAN = "clean"; const val SMART = "smart"; const val LAB = "lab"; const val DEAL = "deal"; fun gadget(id: String) = "gadget/$id"; fun lab(id: String) = "lab/$id"
    fun device(id: String) = "device/$id"; fun component(id: String, key: String) = "device/$id/c/$key"; fun passport(id: String) = "passport/$id"; fun compute(id: String) = "compute/$id"
    fun rescue(id: String, symptom: String) = "rescue/$id/$symptom"
}

// ---------------------------------------------------------------------------------------------- field used by sign-in and the session code
@Composable fun WcField(value: String, onChange: (String) -> Unit, label: String, modifier: Modifier = Modifier, password: Boolean = false, numeric: Boolean = false, mono: Boolean = false) {
    Column(modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
        Eyebrow(label)
        Box(Modifier.fillMaxWidth().padding(top = 6.dp).clip(RoundedCornerShape(14.dp)).background(Wc.colors.surface.copy(alpha = .8f)).border(androidx.compose.foundation.BorderStroke(1.dp, Wc.colors.border), RoundedCornerShape(14.dp)).padding(horizontal = 16.dp, vertical = 15.dp)) {
            BasicTextField(value, onChange, singleLine = true, textStyle = (if (mono) Wc.type.numeral else Wc.type.body).copy(color = Wc.colors.text), cursorBrush = SolidColor(Wc.colors.green),
                visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
                keyboardOptions = KeyboardOptions(keyboardType = if (numeric) KeyboardType.Number else if (password) KeyboardType.Password else KeyboardType.Email), modifier = Modifier.fillMaxWidth())
        }
    }
}

// ---------------------------------------------------------------------------------------------- onboarding (three screens) and first action
@Composable private fun OnboardArt(page: Int) {
    val c = Wc.colors; val icon = listOf(WcIcons.Devices, WcIcons.Check, WcIcons.Home)[page]
    Box(Modifier.fillMaxWidth().height(250.dp), contentAlignment = Alignment.Center) {
        androidx.compose.foundation.Canvas(Modifier.fillMaxSize()) {
            listOf(118f, 86f, 56f).forEachIndexed { i, r ->
                drawCircle(c.green.copy(alpha = .03f + i * .03f), r.dp.toPx())
                drawCircle(c.green.copy(alpha = .20f - i * .03f), r.dp.toPx(), style = androidx.compose.ui.graphics.drawscope.Stroke(1.dp.toPx()))
            }
        }
        IconBadge(icon, c.green, 76.dp)
    }
}

@Composable fun OnboardingScreen(onDone: () -> Unit) {
    var page by remember { mutableIntStateOf(0) }
    val shots = listOf(Pics.phone, Pics.board, Pics.glow)
    val tags = listOf("01 · YOUR DEVICES", "02 · EARLY WARNING", "03 · YOUR CONTROL")
    val pages = listOf(
        "Know your devices." to "Understand the health of your computers and phones, in plain words, with the evidence behind every conclusion.",
        "Catch problems early." to "Battery, storage, cooling, security and hardware health. WorkCare tells you when something needs you, and stays quiet when it does not.",
        "You stay in control." to "Nothing runs, changes or connects without your approval, and every result shows what was actually measured.",
    )
    Column(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color(0xFF080B0A))) {
        // The picture takes the top of the screen and is allowed to be a picture.
        Box(Modifier.fillMaxWidth().weight(1.2f)) {
            androidx.compose.animation.Crossfade(page, animationSpec = tween(200), label = "onboarding-photo") { pg ->
                PhotoBackdrop(shots[pg], Modifier.fillMaxSize(), shape = RoundedCornerShape(bottomStart = 36.dp, bottomEnd = 36.dp), scrimBottom = .55f)
            }
            Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = Wc.gutter).padding(top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Eyebrow("WorkCare", color = PhotoInk); Spacer(Modifier.weight(1f)); if (page < 2) TextAction("Skip", onDone, color = PhotoInk)
            }
            Text(tags[page], style = Wc.type.eyebrow, color = Wc.colors.green, modifier = Modifier.align(Alignment.BottomStart).padding(start = 26.dp, bottom = 22.dp).clip(RoundedCornerShape(8.dp)).background(PhotoInk.copy(alpha = .0f)))
        }
        Column(Modifier.weight(1f).navigationBarsPadding().padding(horizontal = Wc.gutter)) {
            Spacer(Modifier.height(22.dp))
            AnimatedContent(page, transitionSpec = { fadeIn(tween(160)) togetherWith fadeOut(tween(120)) }, label = "onboarding") { p ->
                Column {
                    Text(pages[p].first, style = Wc.type.hero.copy(fontSize = 34.sp, lineHeight = 40.sp), color = Wc.colors.text)
                    Spacer(Modifier.height(10.dp))
                    Text(pages[p].second, style = Wc.type.body, color = Wc.colors.textSecondary)
                }
            }
            Spacer(Modifier.weight(1f))
            Row(Modifier.padding(bottom = 16.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) { repeat(3) { i -> Box(Modifier.height(4.dp).width(if (i == page) 28.dp else 12.dp).clip(RoundedCornerShape(2.dp)).background(if (i == page) Wc.colors.green else Wc.colors.border.copy(alpha = .3f))) } }
            PrimaryButton(if (page == 2) "Get started" else "Continue", { if (page == 2) onDone() else page++ })
            Spacer(Modifier.height(18.dp))
        }
    }
}
private val Wc_green_glow = androidx.compose.ui.graphics.Color(0x2438E078)

@Composable fun FirstActionScreen(onConnectComputer: () -> Unit, onBuyerCheck: () -> Unit, onThisPhone: () -> Unit, onAccount: () -> Unit) {
    Page {
        Spacer(Modifier.height(28.dp))
        Eyebrow("Welcome", color = Wc.colors.green)
        Text("What would you like to do?", style = Wc.type.hero, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp))
        Text("You can do all of these later. Nothing here needs an account except connecting your own computers.", style = Wc.type.body, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 10.dp, bottom = 22.dp))
        ChoiceCard(WcIcons.Laptop, "Connect my computer", "See a computer's health from your phone", onConnectComputer)
        Spacer(Modifier.height(12.dp)); ChoiceCard(WcIcons.Check, "Check a computer before buying", "Inspect a second-hand PC. No account needed", onBuyerCheck)
        Spacer(Modifier.height(12.dp)); ChoiceCard(WcIcons.Phone, "Check this phone", "Battery, storage, security and hardware tests", onThisPhone)
        Spacer(Modifier.height(12.dp)); ChoiceCard(WcIcons.You, "Join my WorkCare account", "Sign in to see your organization's devices", onAccount)
    }
}

/** One large choice: an icon, a title, one line of explanation. */
@Composable fun ChoiceCard(icon: ImageVector, title: String, detail: String, onClick: () -> Unit, tint: androidx.compose.ui.graphics.Color = Wc.colors.green) {
    WcCard(onClick = onClick, padding = 16.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconBadge(icon, tint, 48.dp); Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) { Text(title, style = Wc.type.bodyStrong.copy(fontWeight = FontWeight.SemiBold), color = Wc.colors.text); Text(detail, style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 2.dp)) }
            WcIcon(WcIcons.Chevron, Wc.colors.textSecondary, 18.dp)
        }
    }
}

@Composable fun LoginScreen(vm: AppVm, onBack: () -> Unit, onDone: () -> Unit) {
    var mail by remember { mutableStateOf(vm.email ?: "") }; var pw by remember { mutableStateOf("") }; var code by remember { mutableStateOf("") }
    val signed = vm.signedIn
    androidx.compose.runtime.LaunchedEffect(signed) { if (signed) onDone() }
    Page {
        TopBar(onBack = onBack)
        Spacer(Modifier.height(16.dp))
        IconBadge(WcIcons.You, Wc.colors.green, 52.dp)
        Spacer(Modifier.height(18.dp))
        Eyebrow("WorkCare account", color = Wc.colors.green)
        Text(if (vm.needMfaCode) "Enter your code." else "Sign in.", style = Wc.type.hero, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp))
        Text(if (vm.needMfaCode) "Open your authenticator app and enter the 6-digit code, or a recovery code." else "Use the account you use on the WorkCare web console. Your sign-in is stored encrypted on this phone.", style = Wc.type.body, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 10.dp, bottom = 26.dp))
        if (!vm.needMfaCode) { WcField(mail, { mail = it }, "Email"); Spacer(Modifier.height(16.dp)); WcField(pw, { pw = it }, "Password", password = true) }
        else WcField(code, { code = it }, "Code", numeric = true, mono = true)
        vm.loginError?.let { Notice(it, Severity.CRITICAL, Modifier.padding(top = 12.dp)) }
        Spacer(Modifier.height(22.dp))
        PrimaryButton(if (vm.loginBusy) "Signing in" else "Continue", { vm.login(mail, pw, if (vm.needMfaCode) code else null) }, enabled = !vm.loginBusy && mail.isNotBlank() && pw.isNotBlank() && (!vm.needMfaCode || code.length >= 6))
    }
}

// ---------------------------------------------------------------------------------------------- home
data class Row2(val id: String, val name: String, val model: String?, val status: Severity, val headline: String, val fresh: String, val phone: Boolean)

@Composable fun deviceRows(vm: AppVm): List<Row2> {
    val p = vm.phone; val ph = vm.phoneHealth
    val list = ArrayList<Row2>()
    if (p != null && ph != null) list.add(Row2(R.THIS_PHONE, p.displayName, "This phone", ph.status, ph.headline, "This device", true))
    vm.devices.forEach { d -> list.add(Row2(d.id, d.name, d.model, d.status, d.headline, freshnessText(d.freshness, d.lastSeenAt), d.isPhone )) }
    return list
}

@Composable fun rowPhoto(vm: AppVm, r: Row2): com.viro.workcare.photos.ResolvedPhoto? {
    val (mk, md) = if (r.id == R.THIS_PHONE) (vm.phone?.manufacturer to vm.phone?.model) else makerModel(r.model)
    return rememberDevicePhoto(vm, r.id, mk, md, r.phone)
}

@Composable private fun DeviceRow(vm: AppVm, r: Row2, onClick: () -> Unit) {
    ListRow(r.name, subtitle = listOfNotNull(r.model, r.fresh.takeIf { it != "This device" }).joinToString(" · ").ifEmpty { null }, onClick = onClick,
        leading = { DeviceThumb(vm, r, Wc.colors.status(r.status), 48.dp) }, trailing = { StatusPill(r.status) })
}

// ---------------------------------------------------------------------------------------------- devices
/** The gadget's own picture, small, on its card. Falls back to the representative photo until a better one is found. */
@Composable private fun DeviceThumb(vm: AppVm, r: Row2, tint: androidx.compose.ui.graphics.Color, size: androidx.compose.ui.unit.Dp = 60.dp) {
    val (mk, md) = if (r.id == R.THIS_PHONE) (vm.phone?.manufacturer to vm.phone?.model) else makerModel(r.model)
    val photo = rememberDevicePhoto(vm, r.id, mk, md, r.phone); val shape = RoundedCornerShape(16.dp); val bmp = photo?.bitmap
    Box(Modifier.size(size).clip(shape).border(BorderStroke(1.5.dp, tint.copy(alpha = .45f)), shape).background(Wc.colors.surface), contentAlignment = Alignment.Center) {
        if (bmp != null) androidx.compose.foundation.Image(bmp.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = androidx.compose.ui.layout.ContentScale.Crop)
        else androidx.compose.foundation.Image(androidx.compose.ui.res.painterResource(if (r.phone) Pics.phone else Pics.laptop), null, Modifier.fillMaxSize(), contentScale = androidx.compose.ui.layout.ContentScale.Crop)
    }
}

@Composable fun DevicesScreen(vm: AppVm, go: (String) -> Unit, back: () -> Unit) {
    val all = deviceRows(vm)
    Page {
        TopBar(onBack = back)
        Text("Devices", style = Wc.type.title, color = Wc.colors.text)
        if (vm.signedIn) Text(if (vm.devicesAt > 0) "Updated ${agoText(vm.devicesAt)}" else "Loading", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 4.dp))
        Spacer(Modifier.height(18.dp))
        all.forEach { r ->
            val tint = Wc.colors.status(r.status); val photo = rowPhoto(vm, r); val shape = RoundedCornerShape(CardRadius)
            Column(Modifier.fillMaxWidth().clip(shape).background(cardBrush(if (r.status == Severity.HEALTHY) null else tint)).border(cardBorder(if (r.status == Severity.HEALTHY) null else tint), shape)
                .clickable(role = androidx.compose.ui.semantics.Role.Button) { go(R.device(r.id)) }) {
                Box(Modifier.fillMaxWidth().height(150.dp)) {
                    DevicePhotoImage(photo, Modifier.fillMaxSize(), description = "Picture of ${r.name}")
                    Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Brush.verticalGradient(0.55f to androidx.compose.ui.graphics.Color.Transparent, 1f to androidx.compose.ui.graphics.Color(0xCC060908))))
                    Text(if (r.phone) "PHONE" else "COMPUTER", style = Wc.type.eyebrow, color = PhotoInk, modifier = Modifier.align(Alignment.TopStart).padding(start = 18.dp, top = 16.dp))
                }
                Column(Modifier.padding(16.dp)) {
                    StatusPill(r.status, modifier = Modifier.padding(bottom = 8.dp))
                    Text(r.name, style = Wc.type.bodyStrong.copy(fontWeight = FontWeight.SemiBold), color = Wc.colors.text, maxLines = 1)
                    Text(listOfNotNull(r.model, r.fresh.takeIf { it != "This device" }).joinToString(" · ").ifEmpty { "WorkCare device" }, style = Wc.type.data, color = Wc.colors.textSecondary, maxLines = 1)
                    Text(r.headline, style = Wc.type.data, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp))
                }
            }
            Spacer(Modifier.height(14.dp))
        }
        if (vm.signedIn && vm.devices.isEmpty() && vm.devicesLoad != com.viro.workcare.Load.LOADING)
            EmptyState(WcIcons.Laptop, "No computers yet", "Install WorkCare on a computer and it appears here, or check one right now without installing anything.") { SecondaryButton("Check a computer", { go(R.PAIR) }) }
        if (!vm.signedIn) EmptyState(WcIcons.Laptop, "Connect your first computer", "Sign in to see the computers WorkCare looks after, or check a single PC without an account.") { PrimaryButton("Connect computers", { go(R.LOGIN) }); Spacer(Modifier.height(10.dp)); SecondaryButton("Check a PC without signing in", { go(R.PAIR) }) }
        vm.devicesError?.let { Notice(it) }
    }
}

// ---------------------------------------------------------------------------------------------- device detail and anatomy
@Composable fun DeviceDetailScreen(vm: AppVm, id: String, back: () -> Unit, go: (String) -> Unit) {
    val isPhone = id == R.THIS_PHONE
    val health: DeviceHealth? = if (isPhone) vm.phoneHealth else vm.healthCache[id]
    val summary: DeviceSummary? = vm.devices.firstOrNull { it.id == id }
    androidx.compose.runtime.LaunchedEffect(id) { if (!isPhone) { vm.loadDevice(id); vm.loadPassport(id) } }
    val name = if (isPhone) vm.phone?.displayName ?: "" else summary?.name ?: "Device"
    Page {
        TopBar(onBack = back)
        Spacer(Modifier.height(10.dp))
        run {
            val (mk, md) = if (isPhone) (vm.phone?.manufacturer to vm.phone?.model) else makerModel(summary?.model)
            val photo = rememberDevicePhoto(vm, id, mk, md, isPhone); val pick = rememberPhotoPicker(vm, id)
            DeviceBanner(photo, name = name, onChange = pick)
            if (vm.hasOwnPhoto(id)) TextAction("Remove my photo", { vm.removePhoto(id) }, color = Wc.colors.textSecondary)
            Spacer(Modifier.height(12.dp))
        }
        if (health == null) {
            Text(name, style = Wc.type.title, color = Wc.colors.text)
            Notice(if (vm.devicesError != null) "WorkCare cannot read this device right now." else "Reading this device.", Severity.ATTENTION)
        } else {
            val tint = Wc.colors.status(health.status)
            WcCard(accent = if (health.status == Severity.HEALTHY) null else tint) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconBadge(if (isPhone) WcIcons.Phone else WcIcons.Laptop, tint, 56.dp); Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(name, style = Wc.type.title.copy(fontSize = 22.sp, lineHeight = 28.sp), color = Wc.colors.text, maxLines = 2)
                        Text(if (isPhone) "This phone · Android ${vm.phone?.androidRelease ?: ""}" else summary?.model ?: "", style = Wc.type.data, color = Wc.colors.textSecondary)
                    }
                }
                Spacer(Modifier.height(16.dp))
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) { StatusPill(health.status, if (health.status == Severity.HEALTHY) "Working normally" else statusWord(health.status)); }
                if (health.status != Severity.HEALTHY) Text(health.headline, style = Wc.type.body, color = Wc.colors.text, modifier = Modifier.padding(top = 10.dp))
                val fresh = if (isPhone) "Checked just now" else vm.healthAt[id]?.let { "Checked ${agoText(it)}" } ?: freshnessText(health.freshness, health.lastSeenAt)
                Text(fresh + if (!isPhone && health.freshness != Freshness.LIVE) " · this computer is not reporting right now" else "", style = Wc.type.meta, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 8.dp))
            }

            SectionHeader("Today")
            val nb = health.findings.count { it.severity != Severity.HEALTHY }
            Text(if (nb == 0) "No critical problems detected." else "$nb item${if (nb == 1) "" else "s"} need a look.", style = Wc.type.body, color = Wc.colors.text)

            if (isPhone) { Spacer(Modifier.height(14.dp)); DeepAuditCard(vm, go) }

            SectionHeader("Anatomy")
            WcGroup { health.components.forEach { c -> ComponentRow(c) { go(R.component(id, c.component.key)) } } }

            val bad = health.findings.filter { it.severity != Severity.HEALTHY }
            if (bad.isNotEmpty()) { SectionHeader("Needs attention"); bad.forEach { f -> FindingBlock(f) } }
            if (health.notMeasured.isNotEmpty()) { SectionHeader("Not measured"); health.notMeasured.take(6).forEach { Text(it, style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(vertical = 3.dp)) } }

            SectionHeader("History", action = if (!isPhone) "Passport" else null, onAction = { go(R.passport(id)) })
            val events = if (isPhone) vm.history.take(3).map { it.title to agoText(it.atMillis) } else (vm.passport[id] ?: emptyList()).take(3).map { it.title to dateTimeText(it.at) }
            if (events.isEmpty()) Text("Nothing recorded yet.", style = Wc.type.data, color = Wc.colors.textSecondary) else WcGroup { events.forEach { (t, d) -> ListRow(t, subtitle = d) } }

            SectionHeader("Actions")
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                var msg by remember { mutableStateOf<String?>(null) }
                Column(Modifier.weight(1f)) { SecondaryButton(if (isPhone) "Check again" else "Run check", { if (isPhone) { vm.readPhone(); vm.addHistory("Phone health checked", null) } else vm.runQuickScan(id) { msg = it ?: "Check requested. The computer reports back shortly." } }) }
                Column(Modifier.weight(1f)) { SecondaryButton("Rescue", { go(R.RESCUE) }) }
            }
            if (!isPhone && summary != null) TextAction("Compute", { go(R.compute(id)) }, color = Wc.colors.textSecondary)
            if (isPhone) TextAction("Hardware tests", { go(R.PHONE_TESTS) })
        }
    }
}

@Composable private fun ComponentRow(c: ComponentHealth, onClick: () -> Unit) {
    ListRow(c.label, subtitle = c.detail ?: c.unavailableReason, onClick = onClick, chevron = true,
        trailing = { if (c.severity != null) StatusPill(c.severity) else Text("Not available", style = Wc.type.data, color = Wc.colors.textSecondary) })
}

/** One finding as a card: what is wrong, how it was established, and what to do. */
@Composable fun FindingBlock(f: Finding, showAction: Boolean = true) {
    val tint = Wc.colors.status(f.severity)
    WcCard(accent = if (f.severity == Severity.HEALTHY) null else tint, padding = 16.dp) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) { StatusDot(f.severity); Text(f.title, style = Wc.type.bodyStrong.copy(fontWeight = FontWeight.SemiBold), color = Wc.colors.text, modifier = Modifier.weight(1f)); EvidenceTag(f.type) }
        Text(f.summary, style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 8.dp))
        if (showAction && f.action != null) Text(f.action, style = Wc.type.data.copy(fontWeight = FontWeight.Medium), color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp))
    }
    Spacer(Modifier.height(10.dp))
}

@Composable fun ComponentDetailScreen(vm: AppVm, id: String, key: String, back: () -> Unit, go: (String) -> Unit) {
    val health = if (id == R.THIS_PHONE) vm.phoneHealth else vm.healthCache[id]
    val comp = health?.components?.firstOrNull { it.component.key == key }
    var tab by remember { mutableIntStateOf(0) }
    val mine = health?.findings?.filter { it.component.key == key } ?: emptyList()
    Page {
        TopBar(onBack = back)
        Text(comp?.label ?: "Component", style = Wc.type.title, color = Wc.colors.text, modifier = Modifier.padding(top = 6.dp))
        comp?.detail?.let { Text(it, style = Wc.type.body, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 2.dp)) }
        if (comp?.severity != null) Row(Modifier.padding(top = 10.dp)) { StatusLabel(comp.severity) }
        Spacer(Modifier.height(14.dp))
        TextTabs(listOf("Overview", "Evidence", "Technical", "History", "Actions"), tab) { tab = it }
        Hairline()
        Spacer(Modifier.height(8.dp))
        when (tab) {
            0 -> if (comp == null || comp.severity == null) { Text(comp?.unavailableReason ?: "Not available on this device", style = Wc.type.body, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 8.dp)); Text("WorkCare shows what the device reports. It does not estimate what it cannot read.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 10.dp)) }
                 else if (mine.isEmpty()) Text("No findings for this item. The checks that ran did not flag anything.", style = Wc.type.body, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 8.dp))
                 else mine.forEach { FindingBlock(it) }
            1 -> if (mine.all { it.evidence.isEmpty() }) Text("No measurements are attached to this item.", style = Wc.type.body, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 8.dp))
                 else mine.forEach { f -> Column(Modifier.padding(top = 8.dp)) { Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) { Text(f.title, style = Wc.type.bodyStrong, color = Wc.colors.text, modifier = Modifier.weight(1f)); EvidenceTag(f.type) }; Hairline(Modifier.padding(top = 8.dp)); f.evidence.forEach { e -> KeyValueRow(prettyName(e.name), e.value, e.unit) } } }
            2 -> { mine.forEach { f -> KeyValueRow("Rule", f.id); KeyValueRow("Evidence type", f.type.label.lowercase()); KeyValueRow("Severity", f.severity.name.lowercase()) }; if (mine.isEmpty()) Text("Nothing to show.", style = Wc.type.body, color = Wc.colors.textSecondary); KeyValueRow("Source", if (id == R.THIS_PHONE) "This phone (Android)" else "WorkCare Desktop via Control") }
            3 -> { val ev = if (id == R.THIS_PHONE) vm.history.take(6).map { it.title to agoText(it.atMillis) } else (vm.passport[id] ?: emptyList()).take(6).map { it.title to dateTimeText(it.at) }; if (ev.isEmpty()) Text("Nothing recorded yet.", style = Wc.type.body, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 8.dp)); ev.forEach { (t, d) -> ListRow(t, subtitle = d) } }
            else -> { Spacer(Modifier.height(8.dp)); SecondaryButton("Start Rescue for this", { go(R.RESCUE) }); Spacer(Modifier.height(10.dp)); if (id == R.THIS_PHONE) SecondaryButton("Check again", { vm.readPhone() }) else SecondaryButton("Run a check", { vm.runQuickScan(id) { } }) }
        }
    }
}
fun prettyName(n: String) = n.replace(Regex("([a-z])([A-Z])"), "$1 $2").replaceFirstChar { it.uppercase() }
