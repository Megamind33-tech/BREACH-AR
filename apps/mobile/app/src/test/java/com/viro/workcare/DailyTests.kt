package com.viro.workcare

import com.viro.workcare.daily.DailyStore
import com.viro.workcare.daily.DaySnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val GBD = 1073741824L
private const val DAY = 86_400_000L
private val NOW = 1_790_000_000_000L

private fun snap(daysAgo: Int, free: Double? = 20.0, ids: List<String> = emptyList(), titles: List<String> = ids): DaySnapshot {
    val at = NOW - daysAgo * DAY
    return DaySnapshot(DailyStore.dayKey(at), at, 80, 31.0, free?.let { (it * GBD).toLong() }, 128 * GBD, 100, ids, titles, if (ids.isEmpty()) 0 else 1)
}

class DailyTests {
    @Test fun aStreakCountsConsecutiveDaysAndIsNotLostBeforeTodaysReading() {
        assertEquals(3, DailyStore.streak(listOf(snap(2), snap(1), snap(0)), NOW))
        assertEquals(2, DailyStore.streak(listOf(snap(2), snap(1)), NOW))          // today not read yet: yesterday still counts
        assertEquals(1, DailyStore.streak(listOf(snap(5), snap(0)), NOW))          // a gap resets it
        assertEquals(0, DailyStore.streak(emptyList(), NOW))
        assertEquals(0, DailyStore.streak(listOf(snap(4)), NOW))
    }

    @Test fun changesReportOnlyWhatActuallyChanged() {
        assertTrue(DailyStore.changes(listOf(snap(1))).isEmpty())
        assertTrue(DailyStore.changes(listOf(snap(1), snap(0))).isEmpty())
        val c = DailyStore.changes(listOf(snap(1, ids = listOf("a"), titles = listOf("Old problem")), snap(0, ids = listOf("b"), titles = listOf("New problem"))))
        assertTrue(c.contains("New: New problem")); assertTrue(c.contains("Resolved: Old problem"))
        assertTrue(DailyStore.changes(listOf(snap(1, free = 20.0), snap(0, free = 18.0))).any { it.contains("down 2.0 GB") })
        assertTrue(DailyStore.changes(listOf(snap(1, free = 20.0), snap(0, free = 19.9))).isEmpty())   // below the noise floor
    }

    @Test fun theStorageForecastNeedsAWeekOfRealDecline() {
        val declining = (7 downTo 0).map { d -> snap(d, free = 20.0 - (7 - d) * 0.5) }                  // loses 0.5 GB a day, now at 16.5 GB
        val left = DailyStore.storageDaysLeft(declining); assertNotNull(left); assertTrue("about 33 days, got $left", left!! in 28..38)
        assertNull(DailyStore.storageDaysLeft(declining.takeLast(5)))                                    // too little history
        assertNull(DailyStore.storageDaysLeft((7 downTo 0).map { snap(it, free = 20.0) }))                // flat: no forecast
        assertNull(DailyStore.storageDaysLeft((7 downTo 0).map { d -> snap(d, free = 10.0 + (7 - d) * 0.5) }))   // growing: no forecast
        assertNull(DailyStore.storageDaysLeft((3 downTo 0).map { d -> snap(d, free = 20.0 - (3 - d) * 2.0) }))   // steep but only 3 days
    }
}
