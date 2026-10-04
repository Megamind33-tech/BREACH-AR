package com.viro.workcare.ui

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
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
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.border
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.compose.ui.platform.LocalLifecycleOwner
import com.viro.workcare.AppVm
import com.viro.workcare.CleanPhase
import com.viro.workcare.clean.Cat
import com.viro.workcare.data.Severity
import java.io.File

fun bytesText(b: Long): String = when { b >= 1L shl 30 -> String.format(java.util.Locale.US, "%.1f GB", b / 1073741824.0); b >= 1L shl 20 -> String.format(java.util.Locale.US, "%.0f MB", b / 1048576.0); b >= 1024 -> "${b / 1024} KB"; else -> "$b B" }

fun hasAllFiles(): Boolean = Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()

@Composable fun CleanScreen(vm: AppVm, go: (String) -> Unit) {
    val ctx = LocalContext.current; var allowed by remember { mutableStateOf(hasAllFiles()) }; var confirm by remember { mutableStateOf(false) }; var open by remember { mutableStateOf<Cat?>(null) }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) { val o = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_RESUME) allowed = hasAllFiles() }; owner.lifecycle.addObserver(o); onDispose { owner.lifecycle.removeObserver(o) } }
    val rep = vm.cleanReport; val sel = vm.cleanSelectedItems()
    val ready = vm.cleanPhase == CleanPhase.RESULTS && rep != null && rep.items.isNotEmpty()
    androidx.compose.runtime.key(vm.cleanPhase) { WithCta({ if (ready) BottomCta(if (sel.isEmpty()) "Nothing selected" else "Delete ${sel.size} items", if (sel.isEmpty()) null else bytesText(sel.sumOf { it.bytes }) + " · permanent", enabled = sel.isNotEmpty()) { confirm = true } }) { Page(bottomPad = if (ready) 110.dp else 24.dp) {
        Text("Clean", style = Wc.type.title, color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp, bottom = if (com.viro.workcare.BuildConfig.DEBUG && vm.cleanScope != "Whole storage") 4.dp else 12.dp))
        if (com.viro.workcare.BuildConfig.DEBUG && vm.cleanScope != "Whole storage") Text("Debug scope: ${vm.cleanScope}", style = Wc.type.meta, color = Wc.colors.attention, modifier = Modifier.padding(bottom = 10.dp))
        when (vm.cleanPhase) {
            CleanPhase.IDLE -> {
                if (!allowed) {
                    WcCard { Text("Allow file access to scan", style = Wc.type.section, color = Wc.colors.text)
                        Text("Android asks you to switch on All files access for WorkCare. It is used only here, to find leftovers. Nothing is deleted until you review the list and confirm.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 6.dp, bottom = 14.dp))
                        PrimaryButton("Open the switch", { try { ctx.startActivity(Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + ctx.packageName))) } catch (e: Exception) { Fixes.open(ctx, android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION) } }) }
                } else {
                    val st = try { android.os.StatFs(Environment.getDataDirectory().path) } catch (e: Exception) { null }
                    val freeB = st?.availableBytes ?: 0L; val totB = st?.totalBytes ?: 0L
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        GaugeRing(if (totB == 0L) 0f else 1f - freeB.toFloat() / totB, if (totB > 0 && freeB.toFloat() / totB < .1f) Wc.colors.attention else Wc.colors.green, size = 224.dp, description = "Storage used: " + bytesText(totB - freeB) + " of " + bytesText(totB)) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) { Text(bytesText(freeB), style = Wc.type.numeralLarge.copy(fontSize = 40.sp, lineHeight = 44.sp), color = Wc.colors.text); Text("FREE", style = Wc.type.meta.copy(letterSpacing = 2.sp), color = Wc.colors.green); Text("of " + bytesText(totB), style = Wc.type.meta, color = Wc.colors.textSecondary) }
                        }
                    }
                    Spacer(Modifier.height(14.dp))
                    PrimaryButton("Scan for leftovers", { vm.scanClean() })
                    Text("Finds hidden files, deleted items still stored, thumbnails, temporary files, installers, empty folders, large files and duplicates. Scanning deletes nothing.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 10.dp))
                }
            }
            CleanPhase.SCANNING -> WcCard { Text("Scanning", style = Wc.type.section, color = Wc.colors.text); Text("${vm.cleanFilesSeen} items looked at", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 4.dp)); Text(vm.cleanFolder ?: "", style = Wc.type.meta, color = Wc.colors.textSecondary, maxLines = 1, modifier = Modifier.padding(top = 2.dp, bottom = 12.dp)); SecondaryButton("Stop", { vm.cancelClean() }) }
            CleanPhase.DELETING -> WcCard { Text("Deleting", style = Wc.type.section, color = Wc.colors.text); Text("${vm.cleanDeleteDone} of ${vm.cleanDeleteTotal}", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 4.dp)) }
            CleanPhase.RESULTS -> if (rep != null) {
                val total = sel.sumOf { it.bytes }
                val totalB = rep.items.sumOf { it.bytes }
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    GaugeRing(if (totalB == 0L) 1f else total.toFloat() / totalB, Wc.colors.green, size = 224.dp, description = "Selected for deletion: ${bytesText(total)} of ${bytesText(totalB)}") {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            if (rep.items.isEmpty()) { WcIcon(WcIcons.Tick, Wc.colors.green, 56.dp); Text("CLEAN", style = Wc.type.section.copy(fontWeight = FontWeight.Bold, letterSpacing = 3.sp), color = Wc.colors.text) }
                            else { Text(bytesText(total), style = Wc.type.numeralLarge.copy(fontSize = 44.sp, lineHeight = 48.sp), color = Wc.colors.text); Text("SELECTED", style = Wc.type.meta.copy(letterSpacing = 2.sp), color = Wc.colors.green); Text("of ${bytesText(totalB)} found", style = Wc.type.meta, color = Wc.colors.textSecondary) }
                        }
                    }
                }
                Text(if (rep.items.isEmpty()) "Looked at ${rep.filesLooked} items in ${rep.folders} folders. No leftovers found." else "${rep.items.size} items in ${rep.items.map { it.cat }.toSet().size} groups. Tick what to delete.${if (rep.stoppedEarly) " The scan was stopped early." else ""}", style = Wc.type.data, color = Wc.colors.textSecondary, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                if (rep.items.isNotEmpty()) {
                    Spacer(Modifier.height(12.dp))
                    WcGroup {
                        Cat.entries.filter { rep.of(it).isNotEmpty() }.forEach { c ->
                            val all = rep.of(c)
                            Column {
                                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Checkbox(vm.cleanCats.contains(c), "${c.label}, ${bytesText(rep.bytes(c))}") { vm.toggleCat(c) }
                                    Column(Modifier.weight(1f).clickable(role = Role.Button) { open = if (open == c) null else c }.padding(start = 8.dp)) { Text(c.label, style = Wc.type.bodyStrong, color = Wc.colors.text); Text("${all.size} items · " + bytesText(rep.bytes(c)), style = Wc.type.data, color = Wc.colors.textSecondary) }
                                    Text(if (open == c) "Hide" else "Review", style = Wc.type.data.copy(fontWeight = FontWeight.SemiBold), color = Wc.colors.green, modifier = Modifier.clickable(role = Role.Button) { open = if (open == c) null else c }.padding(8.dp))
                                }
                                if (open == c) {
                                    Text(c.why, style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(start = 56.dp, end = 16.dp, bottom = 6.dp))
                                    all.sortedByDescending { it.bytes }.take(60).forEach { it ->
                                        Row(Modifier.fillMaxWidth().padding(start = 40.dp, end = 16.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                            Checkbox(it.path !in vm.cleanKeep && vm.cleanCats.contains(c), it.path.substringAfterLast('/')) { vm.toggleItem(it.path, c) }
                                            Column(Modifier.padding(start = 8.dp)) { Text(it.path.removePrefix(Environment.getExternalStorageDirectory().path + "/"), style = Wc.type.data, color = Wc.colors.text, maxLines = 2); Text(bytesText(it.bytes) + if (it.isDir) " · folder" else "", style = Wc.type.meta, color = Wc.colors.textSecondary) }
                                        }
                                    }
                                    if (all.size > 60) Text("and ${all.size - 60} more in this group", style = Wc.type.meta, color = Wc.colors.textSecondary, modifier = Modifier.padding(start = 56.dp, bottom = 8.dp))
                                }
                                Hairline(Modifier.padding(start = 16.dp))
                            }
                        }
                    }
                    Spacer(Modifier.height(14.dp))
                    Row(Modifier.fillMaxWidth().toggleable(vm.cleanOverwrite, role = Role.Switch) { vm.cleanOverwrite = it }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) { Text("Overwrite before deleting", style = Wc.type.bodyStrong, color = Wc.colors.text); Text("Writes zeros over each file first. Slower. Phone storage is encrypted, so deleted data is unreadable either way.", style = Wc.type.data, color = Wc.colors.textSecondary) }
                        Spacer(Modifier.width(8.dp)); StatusPill(if (vm.cleanOverwrite) Severity.HEALTHY else Severity.ATTENTION, if (vm.cleanOverwrite) "On" else "Off")
                    }
                    Spacer(Modifier.height(8.dp))
                    SecondaryButton("Scan again", { vm.scanClean() })
                }
            }
            CleanPhase.DONE -> {
                val r = vm.cleanResult
                WcCard(accent = Wc.colors.green) {
                    Text(bytesText(r?.freedBytes ?: 0) + " freed", style = Wc.type.numeralLarge, color = Wc.colors.text)
                    Text("${r?.deleted ?: 0} items permanently deleted." + (vm.cleanFreeBefore?.let { b -> vm.cleanFreeAfter?.let { a -> if (a - b >= 100L * 1048576) " Free space went from ${bytesText(b)} to ${bytesText(a)}." else "" } } ?: ""), style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 4.dp))
                    if (r != null && r.failed.isNotEmpty()) Notice("${r.failed.size} items could not be deleted and are still there.", Severity.ATTENTION)
                    if (r != null && r.refused.isNotEmpty()) Notice("${r.refused.size} items were refused because they are outside your storage area.", Severity.ATTENTION)
                }
                Spacer(Modifier.height(12.dp)); PrimaryButton("Done", { vm.resetClean() }); Spacer(Modifier.height(8.dp)); SecondaryButton("Scan again", { vm.scanClean() })
            }
        }

        SectionHeader("Connections and access")
        Text("WorkCare cannot delete anything from other people's phones or from online accounts. What it can do is open the exact screen where each kind of access on this phone is switched off.", style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(bottom = 10.dp))
        WcGroup { Connections.all(ctx).forEach { c -> ListRow(c.title, subtitle = c.detail, onClick = { Fixes.open(ctx, c.action, c.packageUri) }, chevron = true) } }
    } } }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false }, containerColor = Wc.colors.elevated,
        title = { Text("Delete permanently?", color = Wc.colors.text) },
        text = { Text("${sel.size} items (${bytesText(sel.sumOf { it.bytes })}) will be deleted for good. There is no recycle bin and no undo.", color = Wc.colors.textSecondary) },
        confirmButton = { TextButton({ confirm = false; vm.deleteClean() }) { Text("Delete", color = Wc.colors.critical) } }, dismissButton = { TextButton({ confirm = false }) { Text("Cancel", color = Wc.colors.text) } })
}

@Composable private fun Checkbox(checked: Boolean, label: String, onChange: () -> Unit) {
    Box(Modifier.size(48.dp).toggleable(checked, role = Role.Checkbox, onValueChange = { onChange() }).semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        Box(Modifier.size(22.dp).clip(RoundedCornerShape(6.dp)).background(if (checked) Wc.colors.green else Color.Transparent).then(if (checked) Modifier else Modifier.border(androidx.compose.foundation.BorderStroke(2.dp, Wc.colors.textSecondary), RoundedCornerShape(6.dp))), contentAlignment = Alignment.Center) { if (checked) WcIcon(WcIcons.Tick, Wc.colors.onGreen, 16.dp) }
    }
}
private typealias Color = androidx.compose.ui.graphics.Color
