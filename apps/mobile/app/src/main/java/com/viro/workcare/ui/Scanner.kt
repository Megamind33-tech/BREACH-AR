package com.viro.workcare.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.viro.workcare.photos.ResolvedPhoto

/** Where a scan has got to: the gadget's picture and a dial. The numbers are the checks that really finished; nothing moves on its own. */
@Composable fun ScanPanel(photo: ResolvedPhoto?, done: Boolean, completed: Int, total: Int?, current: String?, name: String?, modifier: Modifier = Modifier) {
    val pct = if (done) 100 else if (total == null || total == 0) 0 else completed * 100 / total
    val line = if (done) "Finished" else current?.let { "Checking ${it.lowercase()}" } ?: "Waiting for the computer"
    Column(modifier.fillMaxWidth(), horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally) {
        DevicePhotoImage(photo, Modifier.height(96.dp).fillMaxWidth(.5f).clip(RoundedCornerShape(16.dp)), description = if (name != null) "Picture of ${name}" else "Picture of the device")
        Spacer(Modifier.height(14.dp))
        GaugeRing(pct / 100f, Wc.colors.green, size = 224.dp, description = "Scan progress, ${pct} percent") {
            Column(horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally) {
                Text("${pct}%", style = Wc.type.numeralLarge.copy(fontSize = androidx.compose.ui.unit.TextUnit(60f, androidx.compose.ui.unit.TextUnitType.Sp), lineHeight = androidx.compose.ui.unit.TextUnit(64f, androidx.compose.ui.unit.TextUnitType.Sp)), color = Wc.colors.text)
                Text(if (total != null) "${completed} of ${total} checks" else "Starting", style = Wc.type.meta, color = Wc.colors.textSecondary)
            }
        }
        Text(line, style = Wc.type.data, color = Wc.colors.text, modifier = Modifier.padding(top = 12.dp))
    }
}
