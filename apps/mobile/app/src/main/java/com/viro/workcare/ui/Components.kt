package com.viro.workcare.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.selection.selectable
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.heading
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.draw.drawBehind
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import com.viro.workcare.data.EvidenceType
import com.viro.workcare.data.Severity

// ---------------------------------------------------------------------------------------------- icons: one hand-drawn line set (24 grid, 1.7 stroke)
private fun icon(name: String, block: androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit) = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
    path(stroke = SolidColor(Color.Black), strokeLineWidth = 1.7f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round, pathBuilder = block)
}.build()

object WcIcons {
    val Home = icon("home") { moveTo(4f, 11f); lineTo(12f, 4.5f); lineTo(20f, 11f); moveTo(6f, 9.8f); lineTo(6f, 19.5f); lineTo(18f, 19.5f); lineTo(18f, 9.8f); moveTo(10f, 19.5f); lineTo(10f, 14f); lineTo(14f, 14f); lineTo(14f, 19.5f) }
    val Devices = icon("devices") { moveTo(3.5f, 6f); lineTo(16.5f, 6f); lineTo(16.5f, 15f); lineTo(3.5f, 15f); close(); moveTo(2f, 18.5f); lineTo(18f, 18.5f); moveTo(14f, 9f); lineTo(20.5f, 9f); lineTo(20.5f, 19f); lineTo(14f, 19f) }
    val Check = icon("check") { moveTo(12f, 3.5f); lineTo(19f, 6.5f); lineTo(19f, 12f); curveTo(19f, 16f, 16f, 19f, 12f, 20.5f); curveTo(8f, 19f, 5f, 16f, 5f, 12f); lineTo(5f, 6.5f); close(); moveTo(8.8f, 12f); lineTo(11f, 14.2f); lineTo(15.4f, 9.6f) }
    val Rescue = icon("rescue") { moveTo(12f, 3.5f); curveTo(7.3f, 3.5f, 3.5f, 7.3f, 3.5f, 12f); curveTo(3.5f, 16.7f, 7.3f, 20.5f, 12f, 20.5f); curveTo(16.7f, 20.5f, 20.5f, 16.7f, 20.5f, 12f); curveTo(20.5f, 7.3f, 16.7f, 3.5f, 12f, 3.5f); close(); moveTo(12f, 8f); lineTo(12f, 12.5f); moveTo(12f, 15.4f); lineTo(12f, 15.6f) }
    val You = icon("you") { moveTo(12f, 4f); curveTo(9.8f, 4f, 8.2f, 5.6f, 8.2f, 7.8f); curveTo(8.2f, 10f, 9.8f, 11.6f, 12f, 11.6f); curveTo(14.2f, 11.6f, 15.8f, 10f, 15.8f, 7.8f); curveTo(15.8f, 5.6f, 14.2f, 4f, 12f, 4f); close(); moveTo(4.8f, 20f); curveTo(5.4f, 16.4f, 8.2f, 14.4f, 12f, 14.4f); curveTo(15.8f, 14.4f, 18.6f, 16.4f, 19.2f, 20f) }
    val Chevron = icon("chevron") { moveTo(9f, 5.5f); lineTo(15.5f, 12f); lineTo(9f, 18.5f) }
    val Back = icon("back") { moveTo(15f, 5.5f); lineTo(8.5f, 12f); lineTo(15f, 18.5f) }
    val Close = icon("close") { moveTo(6f, 6f); lineTo(18f, 18f); moveTo(18f, 6f); lineTo(6f, 18f) }
    val Phone = icon("phone") { moveTo(7.5f, 3f); lineTo(16.5f, 3f); lineTo(16.5f, 21f); lineTo(7.5f, 21f); close(); moveTo(11f, 18f); lineTo(13f, 18f) }
    val Laptop = icon("laptop") { moveTo(5f, 6f); lineTo(19f, 6f); lineTo(19f, 15.5f); lineTo(5f, 15.5f); close(); moveTo(2.5f, 19f); lineTo(21.5f, 19f) }
    val Bell = icon("bell") { moveTo(6f, 16f); lineTo(6f, 11f); curveTo(6f, 7.7f, 8.7f, 5f, 12f, 5f); curveTo(15.3f, 5f, 18f, 7.7f, 18f, 11f); lineTo(18f, 16f); lineTo(19.5f, 18f); lineTo(4.5f, 18f); close(); moveTo(10f, 20.5f); lineTo(14f, 20.5f) }
    val Plus = icon("plus") { moveTo(12f, 5f); lineTo(12f, 19f); moveTo(5f, 12f); lineTo(19f, 12f) }
    val Photo = icon("photo") { moveTo(4f, 5.5f); lineTo(20f, 5.5f); lineTo(20f, 18.5f); lineTo(4f, 18.5f); close(); moveTo(4f, 16f); lineTo(9f, 11f); lineTo(13f, 15f); lineTo(15.5f, 12.5f); lineTo(20f, 17f); moveTo(15.2f, 9f); lineTo(15.3f, 9f) }
    val Lock = icon("lock") { moveTo(6f, 11f); lineTo(18f, 11f); lineTo(18f, 20f); lineTo(6f, 20f); close(); moveTo(8.5f, 11f); lineTo(8.5f, 8f); curveTo(8.5f, 5.8f, 10f, 4.5f, 12f, 4.5f); curveTo(14f, 4.5f, 15.5f, 5.8f, 15.5f, 8f); lineTo(15.5f, 11f); moveTo(12f, 14.5f); lineTo(12f, 16.5f) }
    val Clean = icon("clean") { moveTo(5f, 7f); lineTo(19f, 7f); moveTo(9f, 7f); lineTo(9f, 5f); lineTo(15f, 5f); lineTo(15f, 7f); moveTo(7f, 7f); lineTo(8f, 19.5f); lineTo(16f, 19.5f); lineTo(17f, 7f); moveTo(10.5f, 11f); lineTo(10.5f, 16f); moveTo(13.5f, 11f); lineTo(13.5f, 16f) }
    val Fix = icon("fix") { moveTo(14.5f, 6.5f); curveTo(13.5f, 4.8f, 15f, 3.5f, 17f, 3.8f); lineTo(15.5f, 5.5f); lineTo(16.5f, 7.5f); lineTo(18.5f, 8.5f); lineTo(20.2f, 7f); curveTo(20.5f, 9f, 19.2f, 10.5f, 17.5f, 9.5f); lineTo(8f, 19f); curveTo(7f, 20f, 5.5f, 20f, 4.8f, 19.2f); curveTo(4f, 18.5f, 4f, 17f, 5f, 16f); close() }
    val Battery = icon("battery") { moveTo(4f, 8f); lineTo(18f, 8f); lineTo(18f, 16f); lineTo(4f, 16f); close(); moveTo(18f, 10.5f); lineTo(20.5f, 10.5f); lineTo(20.5f, 13.5f); lineTo(18f, 13.5f); moveTo(8f, 11f); lineTo(8f, 13f); moveTo(11f, 11f); lineTo(11f, 13f) }
    val Chip = icon("chip") { moveTo(7f, 7f); lineTo(17f, 7f); lineTo(17f, 17f); lineTo(7f, 17f); close(); moveTo(10f, 10f); lineTo(14f, 10f); lineTo(14f, 14f); lineTo(10f, 14f); close(); moveTo(10f, 4f); lineTo(10f, 7f); moveTo(14f, 4f); lineTo(14f, 7f); moveTo(10f, 17f); lineTo(10f, 20f); moveTo(14f, 17f); lineTo(14f, 20f); moveTo(4f, 10f); lineTo(7f, 10f); moveTo(4f, 14f); lineTo(7f, 14f); moveTo(17f, 10f); lineTo(20f, 10f); moveTo(17f, 14f); lineTo(20f, 14f) }
    val Radar = icon("radar") { moveTo(12f, 3.5f); curveTo(7.3f, 3.5f, 3.5f, 7.3f, 3.5f, 12f); curveTo(3.5f, 16.7f, 7.3f, 20.5f, 12f, 20.5f); curveTo(16.7f, 20.5f, 20.5f, 16.7f, 20.5f, 12f); curveTo(20.5f, 7.3f, 16.7f, 3.5f, 12f, 3.5f); close(); moveTo(12f, 12f); lineTo(17.5f, 6.5f); moveTo(12f, 7.5f); curveTo(9.5f, 7.5f, 7.5f, 9.5f, 7.5f, 12f) }
    val Tick = icon("tick") { moveTo(5f, 12.5f); lineTo(10f, 17.5f); lineTo(19f, 7f) }
}

@Composable fun WcIcon(icon: ImageVector, tint: Color, size: Dp = 24.dp, modifier: Modifier = Modifier) {
    Image(rememberVectorPainter(icon), contentDescription = null, modifier = modifier.size(size), colorFilter = ColorFilter.tint(tint))
}

// ---------------------------------------------------------------------------------------------- page structure
/** Every screen shares one margin, one top inset and one scroll container, so the app reads as a single piece. */
@Composable fun Page(modifier: Modifier = Modifier, bottomPad: Dp = 24.dp, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxSize().statusBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = Wc.gutter).padding(top = 12.dp, bottom = bottomPad), content = content)
}
@Composable fun Eyebrow(text: String, modifier: Modifier = Modifier, color: Color = Wc.colors.textSecondary) { Text(text.uppercase(), style = Wc.type.eyebrow, color = color, modifier = modifier) }
@Composable fun Hairline(modifier: Modifier = Modifier) { Box(modifier.fillMaxWidth().height(1.dp).background(Wc.colors.border)) }
@Composable fun SectionHeader(title: String, modifier: Modifier = Modifier, action: String? = null, onAction: (() -> Unit)? = null) {
    Row(modifier.fillMaxWidth().padding(top = 28.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Eyebrow(title, Modifier.weight(1f).semantics { heading() })
        if (action != null) Text(action, style = Wc.type.data.copy(fontWeight = FontWeight.Medium), color = Wc.colors.green, modifier = Modifier.clickable(onClick = { onAction?.invoke() }).padding(vertical = 4.dp))
    }
}
@Composable fun TopBar(title: String? = null, onBack: (() -> Unit)? = null, trailing: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
        if (onBack != null) Box(Modifier.padding(end = 8.dp).size(48.dp).clip(CircleShape).background(Wc.colors.surface.copy(alpha = if (Wc.colors.dark) .9f else 1f)).border(BorderStroke(1.dp, Wc.colors.border), CircleShape).clickable(onClick = onBack).semantics { contentDescription = "Back" }, contentAlignment = Alignment.Center) { WcIcon(WcIcons.Back, Wc.colors.text, 20.dp) }
        if (title != null) Text(title, style = Wc.type.section, color = Wc.colors.text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis) else Spacer(Modifier.weight(1f))
        trailing?.invoke()
    }
}

// ---------------------------------------------------------------------------------------------- status
@Composable fun StatusDot(sev: Severity?, size: Dp = 8.dp) {
    val c by animateColorAsState(Wc.colors.status(sev), tween(240), label = "dot")
    Box(Modifier.size(size).clip(CircleShape).background(c))
}
fun statusWord(s: Severity) = when (s) { Severity.HEALTHY -> "Healthy"; Severity.ATTENTION -> "Attention"; Severity.CRITICAL -> "Critical" }
@Composable fun StatusLabel(sev: Severity, text: String = statusWord(sev), modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        StatusDot(sev); Text(text, style = Wc.type.data.copy(fontWeight = FontWeight.Medium), color = if (sev == Severity.HEALTHY) Wc.colors.textSecondary else Wc.colors.status(sev), maxLines = 1)
    }
}
@Composable fun EvidenceTag(t: EvidenceType) {
    Chip(t.label)
}

// ---------------------------------------------------------------------------------------------- rows and data
/** The basic unit of the app: a plain row on the page background, separated by hairlines. No card per fact. */
@Composable fun ListRow(title: String, modifier: Modifier = Modifier, subtitle: String? = null, onClick: (() -> Unit)? = null, trailing: (@Composable () -> Unit)? = null, chevron: Boolean = false, leading: (@Composable () -> Unit)? = null, divider: Boolean = true) {
    val inGroup = LocalInGroup.current
    Column(modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().let { if (onClick != null) it.clickable(role = Role.Button, onClick = onClick) else it }.heightIn(min = if (inGroup) 64.dp else 60.dp).padding(vertical = 12.dp, horizontal = if (inGroup) 16.dp else 0.dp), verticalAlignment = Alignment.CenterVertically) {
            if (leading != null) { leading(); Spacer(Modifier.width(14.dp)) }
            Column(Modifier.weight(1f)) {
                Text(title, style = Wc.type.bodyStrong, color = Wc.colors.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (subtitle != null) Text(subtitle, style = Wc.type.data, color = Wc.colors.textSecondary, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
            }
            if (trailing != null) { Spacer(Modifier.width(12.dp)); trailing() }
            if (chevron) { Spacer(Modifier.width(6.dp)); WcIcon(WcIcons.Chevron, Wc.colors.textSecondary, 18.dp) }
        }
        if (divider) Hairline(if (inGroup) Modifier.padding(start = 16.dp) else Modifier)
    }
}
@Composable fun KeyValueRow(name: String, value: String, unit: String? = null, modifier: Modifier = Modifier, tag: EvidenceType? = null) {
    val inGroup = LocalInGroup.current
    Column(modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(vertical = 13.dp, horizontal = if (inGroup) 16.dp else 0.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(name, style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.weight(1f))
            Text(value + (unit?.let { " $it" } ?: ""), style = Wc.type.bodyStrong.copy(fontFeatureSettings = "tnum"), color = Wc.colors.text, textAlign = TextAlign.End, modifier = Modifier.weight(1.1f))
        }
        Hairline(if (inGroup) Modifier.padding(start = 16.dp) else Modifier)
    }
}
@Composable fun Numeral(value: String, label: String, modifier: Modifier = Modifier, color: Color = Wc.colors.text) {
    Column(modifier) { Text(value, style = Wc.type.numeralLarge, color = color); Text(label, style = Wc.type.data, color = Wc.colors.textSecondary) }
}

// ---------------------------------------------------------------------------------------------- actions
@Composable fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {; val shape = RoundedCornerShape(16.dp); val g = Wc.colors.green
    Box(modifier.fillMaxWidth().heightIn(min = 56.dp).clip(shape)
        .background(if (enabled) g else Wc.colors.surface)
        .clickable(enabled = enabled, onClick = onClick, role = Role.Button), contentAlignment = Alignment.Center) {
        Text(text, style = Wc.type.bodyStrong.copy(fontWeight = FontWeight.SemiBold), color = if (enabled) Wc.colors.onGreen else Wc.colors.textSecondary, modifier = Modifier.padding(horizontal = 16.dp, vertical = 15.dp))
    }
}
@Composable fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {; val shape = RoundedCornerShape(16.dp)
    Box(modifier.fillMaxWidth().heightIn(min = 56.dp).clip(shape).background(Wc.colors.surface.copy(alpha = if (Wc.colors.dark) .55f else .7f)).border(BorderStroke(1.dp, if (enabled) Wc.colors.textSecondary.copy(alpha = .35f) else Wc.colors.border), shape)
        .clickable(enabled = enabled, onClick = onClick, role = Role.Button), contentAlignment = Alignment.Center) {
        Text(text, style = Wc.type.bodyStrong.copy(fontWeight = FontWeight.SemiBold), color = if (enabled) Wc.colors.text else Wc.colors.textSecondary, modifier = Modifier.padding(horizontal = 16.dp, vertical = 15.dp))
    }
}
@Composable fun TextAction(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, color: Color = Wc.colors.green) {
    Text(text, style = Wc.type.bodyStrong, color = color, modifier = modifier.clickable(onClick = onClick, role = Role.Button).padding(vertical = 10.dp, horizontal = 2.dp))
}

/** A quiet one-line notice (offline, stale data, permission denied): never a coloured card. */
@Composable fun Notice(text: String, sev: Severity = Severity.ATTENTION, modifier: Modifier = Modifier) {
    val tint = Wc.colors.status(sev)
    Row(modifier.semantics { liveRegion = LiveRegionMode.Polite }.fillMaxWidth().padding(vertical = 6.dp).clip(RoundedCornerShape(14.dp)).background(tint.copy(alpha = .10f)).border(BorderStroke(1.dp, tint.copy(alpha = .25f)), RoundedCornerShape(14.dp)).padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.padding(top = 6.dp)) { StatusDot(sev) }; Text(text, style = Wc.type.data, color = Wc.colors.text)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun WcSheet(onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Wc.colors.elevated, contentColor = Wc.colors.text, shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp), dragHandle = {
        Box(Modifier.padding(top = 10.dp, bottom = 6.dp).size(width = 36.dp, height = 4.dp).clip(RoundedCornerShape(2.dp)).background(Wc.colors.border.copy(alpha = .3f)))
    }) { Column(Modifier.fillMaxWidth().padding(horizontal = Wc.gutter).padding(bottom = 24.dp).navigationBarsPadding(), content = content) }
}

/** Underlined text tabs (Overview / Evidence / Technical / History / Actions). */
@Composable fun TextTabs(items: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(22.dp)) {
        items.forEachIndexed { i, t ->
            Column(Modifier.selectable(selected = i == selected, role = Role.Tab, onClick = { onSelect(i) })) {
                Text(t, style = Wc.type.bodyStrong, color = if (i == selected) Wc.colors.text else Wc.colors.textSecondary, modifier = Modifier.padding(vertical = 10.dp))
                Box(Modifier.height(2.dp).fillMaxWidth().background(if (i == selected) Wc.colors.green else Color.Transparent))
            }
        }
    }
}

/** True when the person has turned animations off in Android's settings. Indicators then stand still. */
@Composable fun reduceMotion(): Boolean { val c = androidx.compose.ui.platform.LocalContext.current; return try { android.provider.Settings.Global.getFloat(c.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f } catch (e: Exception) { false } }
