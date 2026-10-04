package com.viro.workcare.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.viro.workcare.data.Severity

// The premium layer. It uses only the WorkCare palette: surfaces are the existing background tiers, the accent is the existing green,
// and attention / critical keep their meaning. Nothing here introduces a new brand colour.

internal val LocalInGroup = compositionLocalOf { false }

val CardRadius = 20.dp

/** Cards are flat: one surface colour, a hairline, nothing else. */
@Composable fun cardBrush(accent: Color? = null): Brush {
    val c = Wc.colors
    return SolidColor(if (accent != null) lerp(c.elevated, accent, if (c.dark) .10f else .07f) else if (c.dark) c.surface else c.elevated)
}

@Composable fun cardBorder(accent: Color? = null): BorderStroke = BorderStroke(1.dp, if (accent != null) accent.copy(alpha = .5f) else Wc.colors.border)


/** A surface for one idea: a device, a finding, a choice. Optional accent tints it with a status colour. */
@Composable fun WcCard(modifier: Modifier = Modifier, accent: Color? = null, onClick: (() -> Unit)? = null, padding: Dp = 18.dp, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(CardRadius)
    var m = modifier.fillMaxWidth()
    if (!Wc.colors.dark) m = m.shadow(3.dp, shape, ambientColor = Color(0x1A0B1410), spotColor = Color(0x1A0B1410))
    if (onClick != null) m = m
    m = m.clip(shape).background(cardBrush(accent)).border(cardBorder(accent), shape)
    if (onClick != null) m = m.clickable(role = Role.Button, onClick = onClick)
    Column(m.padding(padding), content = content)
}

/** Rows grouped on one rounded surface with inset dividers (the last divider is trimmed away). */
@Composable fun WcGroup(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(CardRadius)
    var m = modifier.fillMaxWidth()
    if (!Wc.colors.dark) m = m.shadow(3.dp, shape, ambientColor = Color(0x1A0B1410), spotColor = Color(0x1A0B1410))
    Box(m.clip(shape).background(cardBrush()).border(cardBorder(), shape)) {
        CompositionLocalProvider(LocalInGroup provides true) {
            Column(Modifier.layout { measurable, constraints ->
                val p = measurable.measure(constraints); val cut = 1.dp.roundToPx()
                layout(p.width, (p.height - cut).coerceAtLeast(0)) { p.place(0, 0) }
            }, content = content)
        }
    }
}

/** A tinted rounded square holding a line icon: gives every device, choice and step a visual anchor. */
@Composable fun IconBadge(icon: ImageVector, tint: Color = Wc.colors.green, size: Dp = 44.dp, modifier: Modifier = Modifier) {
    Box(modifier.size(size).clip(RoundedCornerShape(size * .3f)).background(tint.copy(alpha = if (Wc.colors.dark) .14f else .12f)).border(BorderStroke(1.dp, tint.copy(alpha = .22f)), RoundedCornerShape(size * .3f)), contentAlignment = Alignment.Center) {
        WcIcon(icon, tint, size * .5f)
    }
}

@Composable fun severityTint(sev: Severity?): Color = Wc.colors.status(sev)

/** A capsule that names a state in a word, tinted by severity. */
@Composable fun StatusPill(sev: Severity, text: String = statusWord(sev), modifier: Modifier = Modifier) {
    val tint = Wc.colors.status(sev)
    Row(modifier.clip(RoundedCornerShape(50)).background(tint.copy(alpha = if (Wc.colors.dark) .14f else .12f)).padding(horizontal = 10.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(tint))
        Text(text, style = Wc.type.meta.copy(fontWeight = FontWeight.SemiBold), color = if (sev == Severity.HEALTHY && !Wc.colors.dark) Wc.colors.green else tint, maxLines = 1)
    }
}

/** A small tinted label (evidence type, counts). */
@Composable fun Chip(text: String, modifier: Modifier = Modifier, tint: Color = Wc.colors.textSecondary) {
    Text(text.uppercase(), style = Wc.type.eyebrow.copy(fontSize = 10.sp, letterSpacing = 1.1.sp), color = tint, maxLines = 1, softWrap = false, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
        modifier = modifier.clip(RoundedCornerShape(6.dp)).background(tint.copy(alpha = .10f)).padding(horizontal = 7.dp, vertical = 3.dp))
}

/** Real counts drawn as a ring: healthy, attention and critical shares of the devices WorkCare actually has. */
@Composable fun HealthRing(healthy: Int, attention: Int, critical: Int, modifier: Modifier = Modifier, size: Dp = 96.dp, stroke: Dp = 9.dp, center: @Composable () -> Unit = {}) {
    val c = Wc.colors; val total = (healthy + attention + critical).coerceAtLeast(1)
    val grow = 1f
    Box(modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(size)) {
            val sw = stroke.toPx(); val inset = sw / 2f; val arc = Size(this.size.width - sw, this.size.height - sw)
            drawArc(c.border.copy(alpha = .16f), 0f, 360f, false, Offset(inset, inset), arc, style = Stroke(sw))
            var start = -90f; val gap = if ((healthy > 0).toInt() + (attention > 0).toInt() + (critical > 0).toInt() > 1) 8f else 0f
            listOf(healthy to c.green, attention to c.attention, critical to c.critical).forEach { (n, col) ->
                if (n > 0) { val sweep = 360f * n / total * grow - gap; drawArc(col, start + gap / 2, sweep.coerceAtLeast(1f), false, Offset(inset, inset), arc, style = Stroke(sw, cap = StrokeCap.Round)); start += 360f * n / total * grow }
            }
        }
        center()
    }
}
private fun Boolean.toInt() = if (this) 1 else 0

/** A numbered instruction: used wherever the user must do something on another device. */
@Composable fun StepRow(n: Int, title: String, detail: String? = null) {
    Row(Modifier.fillMaxWidth().padding(vertical = 9.dp), verticalAlignment = Alignment.Top) {
        Box(Modifier.size(28.dp).clip(CircleShape).background(Wc.colors.green.copy(alpha = .14f)), contentAlignment = Alignment.Center) { Text("$n", style = Wc.type.meta.copy(fontWeight = FontWeight.Bold), color = Wc.colors.green) }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = Wc.type.bodyStrong, color = Wc.colors.text)
            if (detail != null) Text(detail, style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 2.dp))
        }
    }
}

/** A calm, complete empty state: an icon, one sentence of what is going on, and the next step. */
@Composable fun EmptyState(icon: ImageVector, title: String, body: String, modifier: Modifier = Modifier, tint: Color = Wc.colors.green, action: (@Composable () -> Unit)? = null) {
    WcCard(modifier) {
        IconBadge(icon, tint, 48.dp)
        Text(title, style = Wc.type.section, color = Wc.colors.text, modifier = Modifier.padding(top = 14.dp))
        Text(body, style = Wc.type.data, color = Wc.colors.textSecondary, modifier = Modifier.padding(top = 4.dp))
        if (action != null) { Spacer(Modifier.height(16.dp)); action() }
    }
}

/** One real measurement, big. The bar (when there is one) shows a true share, never an estimate. */
@Composable fun VitalTile(label: String, value: String, sub: String, tint: Color, modifier: Modifier = Modifier, fraction: Float? = null) {
    WcCard(modifier, padding = 14.dp) {
        Text(label.uppercase(), style = Wc.type.eyebrow.copy(letterSpacing = 1.sp), color = Wc.colors.textSecondary, maxLines = 1, softWrap = false)
        Text(value, style = Wc.type.numeralLarge.copy(fontSize = 28.sp, lineHeight = 32.sp), color = Wc.colors.text, modifier = Modifier.padding(top = 8.dp), maxLines = 2)
        Text(sub, style = Wc.type.meta, color = Wc.colors.textSecondary, maxLines = 2, modifier = Modifier.padding(top = 2.dp))
        if (fraction != null) {
            Spacer(Modifier.height(10.dp))
            Box(Modifier.fillMaxWidth().height(5.dp).clip(RoundedCornerShape(3.dp)).background(Wc.colors.border.copy(alpha = .18f))) { Box(Modifier.fillMaxWidth(fraction.coerceIn(0.02f, 1f)).height(5.dp).clip(RoundedCornerShape(3.dp)).background(tint)) }
        }
    }
}
