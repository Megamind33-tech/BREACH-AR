package com.viro.workcare.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The instrument layer: what makes the app read as a phone utility. A 270-degree gauge with a counter in it, a status banner, tool tiles that carry a live value, and one fixed action
// at the bottom. Every number shown through these is a real reading or a real count; nothing here animates on its own.

/** An open ring (gap at the bottom, like a dial). [fraction] is 0..1 of the arc that is filled. */
@Composable fun GaugeRing(fraction: Float, tint: Color, modifier: Modifier = Modifier, size: Dp = 220.dp, stroke: Dp = 16.dp, description: String? = null, content: @Composable BoxScope.() -> Unit) {
    val track = Wc.colors.border; val f = fraction.coerceIn(0f, 1f)
    Box(modifier.size(size).let { m -> if (description != null) m.semantics { contentDescription = description; progressBarRangeInfo = ProgressBarRangeInfo(f, 0f..1f) } else m }, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val sw = stroke.toPx(); val inset = sw / 2f + 2.dp.toPx(); val arc = Size(this.size.width - inset * 2, this.size.height - inset * 2)
            // fine tick marks around the dial, like an instrument
            val cx = this.size.width / 2; val cy = this.size.height / 2; val rOut = this.size.width / 2 - 1.dp.toPx(); val rIn = rOut - 4.dp.toPx()
            for (i in 0..54) { val a = Math.toRadians((135.0 + 270.0 * i / 54)); val c = Math.cos(a).toFloat(); val s = Math.sin(a).toFloat(); drawLine(track.copy(alpha = if (i % 9 == 0) .55f else .28f), Offset(cx + c * rIn, cy + s * rIn), Offset(cx + c * rOut, cy + s * rOut), if (i % 9 == 0) 2.dp.toPx() else 1.dp.toPx()) }
            val pad = 14.dp.toPx()
            drawArc(track.copy(alpha = .22f), 135f, 270f, false, Offset(inset + pad, inset + pad), Size(arc.width - pad * 2, arc.height - pad * 2), style = Stroke(sw, cap = StrokeCap.Round))
            if (f > 0f) drawArc(Brush.sweepGradient(listOf(tint.copy(alpha = .55f), tint, tint), Offset(cx, cy)), 135f, 270f * f, false, Offset(inset + pad, inset + pad), Size(arc.width - pad * 2, arc.height - pad * 2), style = Stroke(sw, cap = StrokeCap.Round))
        }
        content()
    }
}

/** STATUS / YOUR PHONE IS SAFE: one line that says where things stand. The key word carries the colour. */
@Composable fun StatusBanner(prefix: String, keyword: String, tint: Color, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val shape = RoundedCornerShape(14.dp)
    Row(modifier.fillMaxWidth().clip(shape).background(Brush.horizontalGradient(listOf(tint.copy(alpha = .16f), tint.copy(alpha = .03f)))).border(BorderStroke(1.dp, tint.copy(alpha = .35f)), shape).let { if (onClick != null) it.clickable(role = Role.Button, onClick = onClick) else it }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(4.dp).height(34.dp).clip(RoundedCornerShape(2.dp)).background(tint)); Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text("STATUS", style = Wc.type.eyebrow, color = Wc.colors.textSecondary)
            Row { Text(prefix + " ", style = Wc.type.section, color = Wc.colors.text); Text(keyword, style = Wc.type.section.copy(fontWeight = FontWeight.Bold), color = tint) }
        }
        if (onClick != null) WcIcon(WcIcons.Chevron, Wc.colors.textSecondary, 18.dp)
    }
}

/** A tool with its live value: a large line glyph in a ring, the number, the name and one line of context. */
@Composable fun ToolCard(icon: ImageVector, label: String, value: String, caption: String, tint: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(22.dp); val c = Wc.colors
    Column(modifier.clip(shape).background(Brush.verticalGradient(listOf(lerp(c.surface, tint, if (c.dark) .16f else .10f), if (c.dark) c.surface else c.elevated))).border(BorderStroke(1.dp, tint.copy(alpha = .30f)), shape)
        .clickable(role = Role.Button, onClickLabel = label, onClick = onClick).padding(16.dp).semantics(mergeDescendants = true) { contentDescription = "$label, $value, $caption" }) {
        Box(Modifier.size(52.dp).clip(CircleShape).border(BorderStroke(1.5.dp, tint.copy(alpha = .75f)), CircleShape).background(tint.copy(alpha = .10f)), contentAlignment = Alignment.Center) { WcIcon(icon, tint, 28.dp) }
        Spacer(Modifier.height(14.dp))
        Text(value, style = Wc.type.numeralLarge.copy(fontSize = 30.sp, lineHeight = 34.sp), color = c.text, maxLines = 2)
        Text(label.uppercase(), style = Wc.type.eyebrow, color = tint, modifier = Modifier.padding(top = 4.dp), maxLines = 1)
        Text(caption, style = Wc.type.meta, color = c.textSecondary, modifier = Modifier.padding(top = 2.dp), maxLines = 2)
    }
}

/** The one primary action of a screen, pinned above the tab bar: a wide, tall bar with a short imperative label. */
@Composable fun BottomCta(label: String, sub: String? = null, enabled: Boolean = true, onClick: () -> Unit) {
    val c = Wc.colors; val shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)
    Box(Modifier.fillMaxWidth().clip(shape).background(if (enabled) Brush.verticalGradient(listOf(lerp(c.green, Color.White, if (c.dark) .12f else .06f), c.green)) else Brush.verticalGradient(listOf(c.surface, c.surface)))
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).heightIn(min = 68.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(vertical = 14.dp)) {
            Text(label.uppercase(), style = Wc.type.section.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.5.sp), color = if (enabled) c.onGreen else c.textSecondary)
            if (sub != null) Text(sub, style = Wc.type.meta, color = if (enabled) c.onGreen.copy(alpha = .75f) else c.textSecondary)
        }
    }
}

/** Wraps a screen so a [BottomCta] sits fixed at its foot while the content scrolls behind it. */
@Composable fun WithCta(cta: @Composable () -> Unit, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize()) { content(); Box(Modifier.align(Alignment.BottomCenter)) { cta() } }
}
