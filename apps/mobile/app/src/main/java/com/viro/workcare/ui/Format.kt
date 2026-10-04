package com.viro.workcare.ui

import com.viro.workcare.data.Freshness
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale


fun agoText(millis: Long, now: Long = System.currentTimeMillis()): String {
    val s = ((now - millis) / 1000).coerceAtLeast(0)
    return when { s < 90 -> "just now"; s < 3600 -> "${s / 60} min ago"; s < 86400 -> "${s / 3600} h ago"; else -> "${s / 86400} d ago" }
}
fun isoMillis(iso: String?): Long? = try { iso?.let { Instant.parse(it).toEpochMilli() } } catch (e: Exception) { null }
fun isoAgo(iso: String?): String? = isoMillis(iso)?.let { agoText(it) }
fun dateText(millis: Long): String = DateTimeFormatter.ofPattern("dd MMM yyyy", Locale.getDefault()).withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(millis)).uppercase()
fun dateTimeText(iso: String): String = isoMillis(iso)?.let { DateTimeFormatter.ofPattern("dd MMM yyyy · HH:mm", Locale.getDefault()).withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(it)) } ?: iso

/** "Last seen now" for a live device, a dated phrase for anything older: stale information is never worded as live. */
fun freshnessText(f: Freshness, lastSeenIso: String?): String = when (f) {
    Freshness.LIVE -> "Last seen now"
    Freshness.NEVER -> "Not seen yet"
    else -> isoAgo(lastSeenIso)?.let { "Last seen $it" } ?: "Last seen a while ago"
}
