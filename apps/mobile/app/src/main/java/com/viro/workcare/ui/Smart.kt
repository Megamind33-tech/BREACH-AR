package com.viro.workcare.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.background
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.viro.workcare.AppVm
import com.viro.workcare.data.Severity

/** One run of everything that can be read on this phone: health, security, storage. Progress is the number of those that really finished. */
@Composable fun SmartScanScreen(vm: AppVm, go: (String) -> Unit, back: () -> Unit) {
    val c = Wc.colors; val stages = vm.smartStages
    LaunchedEffect(Unit) { if (!vm.smartRunning && !vm.smartDone) vm.runSmart() }
    val finished = stages.count { it.state == "done" || it.state == "skipped" }; val total = stages.size.coerceAtLeast(1)
    val bad = vm.phoneHealth?.findings.orEmpty().filter { it.severity != Severity.HEALTHY }
    val junk = vm.cleanReport?.items?.filter { it.cat.selected }?.sumOf { it.bytes } ?: 0L
    val tint = if (!vm.smartDone) c.green else c.status(bad.fold(Severity.HEALTHY) { a, f -> a.worse(f.severity) })
    WithCta({
        if (vm.smartDone) { if (bad.isNotEmpty()) BottomCta("Fix ${bad.size} thing${if (bad.size == 1) "" else "s"}", "See what to do") { vm.finishSmart(); go(R.RESCUE) } else BottomCta("Done") { vm.finishSmart(); back() } }
        else BottomCta("Scanning", "${finished} of $total finished", enabled = false) { }
    }) {
        Page(bottomPad = 110.dp) {
            TopBar(onBack = { vm.finishSmart(); back() })
            Text("Smart scan", style = Wc.type.title, color = c.text, modifier = Modifier.padding(top = 4.dp, bottom = 12.dp))
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                GaugeRing(finished.toFloat() / total, tint, size = 232.dp, description = "Scan progress, $finished of $total finished") {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        if (vm.smartDone) { WcIcon(WcIcons.Tick, tint, 56.dp); Text("DONE", style = Wc.type.section.copy(fontWeight = FontWeight.Bold, letterSpacing = 3.sp), color = c.text) }
                        else { Text("${finished * 100 / total}%", style = Wc.type.numeralLarge.copy(fontSize = 64.sp, lineHeight = 68.sp), color = c.text); Text(stages.firstOrNull { it.state == "running" }?.label?.uppercase() ?: "STARTING", style = Wc.type.meta.copy(letterSpacing = 2.sp), color = c.textSecondary) }
                    }
                }
            }
            Spacer(Modifier.height(18.dp))
            WcGroup {
                stages.forEach { s ->
                    ListRow(s.label, subtitle = s.detail, leading = {
                        Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) {
                            when (s.state) { "done" -> WcIcon(WcIcons.Tick, c.green, 22.dp); "running" -> Spinner(22.dp); "skipped" -> Text("–", style = Wc.type.section, color = c.textSecondary); else -> Box(Modifier.size(8.dp).clip(androidx.compose.foundation.shape.CircleShape).background(c.border.copy(alpha = .4f))) }
                        }
                    }, trailing = { Text(when (s.state) { "done" -> "Done"; "running" -> "Checking"; "skipped" -> "Not run"; else -> "Waiting" }, style = Wc.type.data, color = if (s.state == "running") c.text else c.textSecondary) })
                }
            }
            if (vm.smartDone) {
                SectionHeader("Result")
                WcGroup {
                    ListRow(if (bad.isEmpty()) "No problems found" else "${bad.size} thing${if (bad.size == 1) "" else "s"} to fix", subtitle = bad.firstOrNull()?.title, onClick = { vm.finishSmart(); go(R.RESCUE) }, chevron = true, leading = { IconBadge(WcIcons.Check, tint, 40.dp) })
                    if (vm.cleanReport != null) ListRow(if (junk == 0L) "No leftovers found" else bytesText(junk) + " of leftovers", subtitle = "Hidden, temporary and deleted-but-stored files", onClick = { vm.finishSmart(); go(R.CLEAN) }, chevron = true, leading = { IconBadge(WcIcons.Clean, c.green, 40.dp) })
                }
            }
        }
    }
}

