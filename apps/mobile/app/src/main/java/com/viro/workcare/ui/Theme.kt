package com.viro.workcare.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp

/** The WorkCare palette. Green means health, readiness, connection or the one primary action: it is not decoration. */
@Immutable
class WcColors(
    val bg: Color, val elevated: Color, val surface: Color, val green: Color, val onGreen: Color,
    val text: Color, val textSecondary: Color, val border: Color, val attention: Color, val critical: Color, val dark: Boolean,
) {
    fun status(s: com.viro.workcare.data.Severity?) = when (s) {
        com.viro.workcare.data.Severity.CRITICAL -> critical
        com.viro.workcare.data.Severity.ATTENTION -> attention
        com.viro.workcare.data.Severity.HEALTHY -> green
        null -> textSecondary
    }
}

val DarkColors = WcColors(
    bg = Color(0xFF080B0A), elevated = Color(0xFF0E1311), surface = Color(0xFF151B18), green = Color(0xFF38E078), onGreen = Color(0xFF04140B),
    text = Color(0xFFF3F7F4), textSecondary = Color(0xFF97A39C), border = Color(0x14FFFFFF), attention = Color(0xFFE9B44C), critical = Color(0xFFF2685C), dark = true,
)
// Light is designed, not inverted: a warm-neutral paper, a deeper green that still reads on white, hairlines that stay visible.
val LightColors = WcColors(
    bg = Color(0xFFF5F7F5), elevated = Color(0xFFFFFFFF), surface = Color(0xFFECF0ED), green = Color(0xFF0B7A3E), onGreen = Color(0xFFFFFFFF),
    text = Color(0xFF0B1410), textSecondary = Color(0xFF55635B), border = Color(0x1F0B1410), attention = Color(0xFF9A6200), critical = Color(0xFFB3261E), dark = false,
)

val LocalWc = staticCompositionLocalOf { DarkColors }

/** Type scale from the product brief: hero 30, title 26, section 18, body 16, data 14, metadata 12. Numerals are tabular and heavy. */
@Immutable
class WcType(
    val hero: TextStyle, val title: TextStyle, val section: TextStyle, val body: TextStyle, val bodyStrong: TextStyle, val data: TextStyle,
    val meta: TextStyle, val eyebrow: TextStyle, val numeral: TextStyle, val numeralLarge: TextStyle,
)
private val base = FontFamily.Default
val Type = WcType(
    hero = TextStyle(fontFamily = base, fontSize = 30.sp, lineHeight = 36.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.4).sp),
    title = TextStyle(fontFamily = base, fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.3).sp),
    section = TextStyle(fontFamily = base, fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
    body = TextStyle(fontFamily = base, fontSize = 16.sp, lineHeight = 23.sp, fontWeight = FontWeight.Normal),
    bodyStrong = TextStyle(fontFamily = base, fontSize = 16.sp, lineHeight = 23.sp, fontWeight = FontWeight.Medium),
    data = TextStyle(fontFamily = base, fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Normal),
    meta = TextStyle(fontFamily = base, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.2.sp),
    eyebrow = TextStyle(fontFamily = base, fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.6.sp),
    numeral = TextStyle(fontFamily = base, fontSize = 22.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold, fontFeatureSettings = "tnum"),
    numeralLarge = TextStyle(fontFamily = base, fontSize = 40.sp, lineHeight = 44.sp, fontWeight = FontWeight.SemiBold, fontFeatureSettings = "tnum", letterSpacing = (-0.8).sp),
)
val LocalType = staticCompositionLocalOf { Type }

object Wc {
    val colors: WcColors @Composable get() = LocalWc.current
    val type: WcType @Composable get() = LocalType.current
    val gutter = 20.dp          // horizontal page margin: same on every screen
    val radius = 12.dp          // one corner radius for grouped surfaces
}

@Composable
fun WorkCareTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val c = if (dark) DarkColors else LightColors
    val scheme = if (dark) darkColorScheme(primary = c.green, onPrimary = c.onGreen, background = c.bg, surface = c.elevated, onSurface = c.text, onBackground = c.text, surfaceVariant = c.surface, outline = c.border, error = c.critical)
    else lightColorScheme(primary = c.green, onPrimary = c.onGreen, background = c.bg, surface = c.elevated, onSurface = c.text, onBackground = c.text, surfaceVariant = c.surface, outline = c.border, error = c.critical)
    CompositionLocalProvider(LocalWc provides c, LocalType provides Type) { MaterialTheme(colorScheme = scheme, content = content) }
}
