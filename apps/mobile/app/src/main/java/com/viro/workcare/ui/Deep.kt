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
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.viro.workcare.AppVm
import com.viro.workcare.BuildConfig
import com.viro.workcare.data.Severity
import com.viro.workcare.data.Tier
import com.viro.workcare.phone.AuditCatalog

/**
 * The deeper audit, and what the free scan says about it.
 * Rule for this card: the free scan never claims a problem it has not found, and never hides a problem it has. Safety problems found by the essential checks are always shown free.
 * What Plus adds is more checks, run on request, with their results: the card lists them by name and says plainly that they have not been run.
 */
@Composable fun DeepAuditCard(vm: AppVm, go: (String) -> Unit, modifier: Modifier = Modifier) {
    val checks = AuditCatalog.phone; val deep = vm.phoneDeep
    if (vm.plus) {
        val found = vm.phoneHealth?.findings?.filter { it.tier == Tier.DEEP }.orEmpty()
        if (deep == null) WcCard(modifier, accent = Wc.colors.green) {
            Eyebrow("Deep audit · Plus", color = Wc.colors.green)
            Text("${checks.size} deeper checks have not run yet", style = Wc.type.section, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp))
            Text("They look at accessibility control, notification access, device administrators, added certificates, proxy, USB debugging, system integrity and which apps hold sensitive permissions. Nothing leaves this phone.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 6.dp, bottom = 14.dp))
            PrimaryButton(if (vm.deepRunning) "Auditing…" else "Run deep audit", { vm.runPhoneDeep() }, enabled = !vm.deepRunning)
        } else {
            val bad = found.filter { it.severity != Severity.HEALTHY }
            WcCard(modifier, accent = if (bad.isEmpty()) Wc.colors.green else Wc.colors.attention) {
                Row(verticalAlignment = Alignment.CenterVertically) { Eyebrow("Deep audit · Plus", color = Wc.colors.green, modifier = Modifier.weight(1f)); Text(agoText(deep.takenAtMillis), style = Wc.type.meta, color = Wc.colors.textSecondary) }
                Text(if (bad.isEmpty()) "${found.size} deeper checks passed" else "${bad.size} of ${found.size} deeper checks need a look", style = Wc.type.section, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp))
                Text(if (bad.isEmpty()) "Nothing unusual in accessibility, notification access, administrators, certificates, proxy, debugging, system integrity or app permissions." else bad.first().title + ". Open the device to see the evidence.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 6.dp, bottom = 14.dp))
                SecondaryButton(if (vm.deepRunning) "Auditing…" else "Run again", { vm.runPhoneDeep() }, enabled = !vm.deepRunning)
            }
        }
    } else {
        WcCard(modifier) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) { WcIcon(WcIcons.Lock, Wc.colors.green, 18.dp); Eyebrow("Deep audit · WorkCare Plus", color = Wc.colors.green) }
            Text("${checks.size} deeper checks were not run", style = Wc.type.section, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp))
            Text("The free scan covers battery condition, storage, memory, heat, screen lock, encryption and security updates, and it always shows you a safety problem. These checks go further, and have not been run:", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 6.dp, bottom = 10.dp))
            checks.take(5).forEach { c -> Row(Modifier.padding(vertical = 4.dp), verticalAlignment = Alignment.Top) { WcIcon(WcIcons.Lock, Wc.colors.textSecondary, 14.dp, Modifier.padding(top = 3.dp)); Spacer(Modifier.width(10.dp)); Text(c.title, style = Wc.type.data, color = Wc.colors.text) } }
            if (checks.size > 5) Text("and ${checks.size - 5} more", style = Wc.type.meta, color = Wc.colors.textSecondary, modifier = Modifier.padding(start = 24.dp, top = 2.dp))
            Text("Because they have not run, WorkCare cannot tell you whether anything is wrong.", style = Wc.type.data.copy(fontWeight = FontWeight.Medium), color = Wc.colors.text, modifier = Modifier.padding(top = 10.dp, bottom = 14.dp))
            PrimaryButton("See what Plus includes", { go(R.PLUS) })
        }
    }
}

@Composable fun PlusScreen(vm: AppVm, back: () -> Unit) {
    val checks = AuditCatalog.phone
    Page {
        TopBar(onBack = back)
        Text("WorkCare Plus", style = Wc.type.title, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp))
        Text("More checks and more history. Free keeps showing every safety problem it finds.", style = Wc.type.body, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 6.dp))
        Spacer(Modifier.height(16.dp))
        if (vm.plus) { WcCard(accent = Wc.colors.green) { Eyebrow("Active", color = Wc.colors.green); Text(vm.plusSource ?: "Plus is active", style = Wc.type.section, color = Wc.colors.text, modifier = Modifier.padding(top = 6.dp)) }; Spacer(Modifier.height(4.dp)) }

        SectionHeader("Always free")
        Text("Free never hides a safety problem. If the essential checks find one, you see it.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(bottom = 10.dp))
        WcGroup {
            listOf("Phone: battery condition, heat, storage, memory, screen lock, encryption, security updates", "Computer: drive health and wear, battery wear, memory, processor heat, Defender and firewall, Windows summary", "Rescue: what is wrong, with the evidence", "A daily check and a 7-day history").forEach { ListRow(it, leading = { WcIcon(WcIcons.Tick, Wc.colors.green, 20.dp) }) }
        }

        SectionHeader("What Plus adds")
        Text("Deeper checks that need more access and more time. Each one is real and listed here by name.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(bottom = 10.dp))
        WcGroup { checks.forEach { c -> ListRow(c.title, subtitle = c.why, leading = { WcIcon(WcIcons.Lock, Wc.colors.green, 20.dp) }) } }
        Spacer(Modifier.height(10.dp))
        Text("On a computer, Plus also runs the deep Windows audit: encryption, Secure Boot, update and reboot state, Defender freshness, risky settings and the last 30 days of crashes. It is shown when you check a PC.", style = Wc.type.data, color = Wc.colors.textSecondary)
        Text("Plus also keeps 90 days of history and trends instead of 7.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 8.dp))

        SectionHeader("Getting it")
        if (vm.plus) Text("You already have it.", style = Wc.type.body, color = Wc.colors.text)
        else {
            WcCard {
                Text("Plus is included with a WorkCare organization account. Sign in to use it.", style = Wc.type.body, color = Wc.colors.text)
                Spacer(Modifier.height(12.dp))
                PrimaryButton("Sign in", { back() })
            }
            Spacer(Modifier.height(10.dp))
            Text("Buying Plus on its own is not connected yet. This build has no store checkout, so nothing here can charge you.", style = Wc.type.data, color = Wc.colors.textSecondary)
        }
        if (BuildConfig.DEBUG) {
            Spacer(Modifier.height(18.dp))
            val ctx = androidx.compose.ui.platform.LocalContext.current
            SecondaryButton("Run the daily check now (debug build only)", { vm.recordToday(); com.viro.workcare.daily.DailyCheckReceiver().onReceive(ctx, null) })
            Spacer(Modifier.height(10.dp))
            SecondaryButton(if (vm.plusTest) "Testing unlock: on (tap to turn off)" else "Turn on Plus for testing (debug build only)", { vm.enablePlusTest(!vm.plusTest) })
        }
    }
}
