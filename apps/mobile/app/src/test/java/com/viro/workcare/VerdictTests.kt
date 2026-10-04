package com.viro.workcare

import com.viro.workcare.data.EvidenceType
import com.viro.workcare.gadget.Action
import com.viro.workcare.gadget.Condition
import com.viro.workcare.gadget.Decide
import com.viro.workcare.gadget.Kind
import com.viro.workcare.gadget.Part
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private fun part(key: String, c: Condition, head: String = "x") = Part(key, key.replaceFirstChar { it.uppercase() }, c, head, emptyList(), "", EvidenceType.MEASURED)

class VerdictTests {
    @Test fun aHealthyGadgetIsKept() {
        val v = Decide.verdict(Kind.PHONE, 2.0, listOf(part("battery", Condition.HEALTHY), part("storage", Condition.HEALTHY), part("memory", Condition.HEALTHY), part("display", Condition.HEALTHY)), false, 0)
        assertEquals(Action.KEEP, v.action); assertEquals("HIGH", v.confidence)
    }
    @Test fun oneWornPartOnAYoungGadgetMeansReplaceThatPartNotTheGadget() {
        val v = Decide.verdict(Kind.PHONE, 2.0, listOf(part("battery", Condition.REPLACEMENT_ADVISED, "holds 58%"), part("storage", Condition.HEALTHY), part("memory", Condition.HEALTHY)), false, 0)
        assertEquals(Action.REPAIR, v.action); assertTrue(v.headline.contains("battery"))
    }
    @Test fun aWornPartOnAnOldGadgetPlusNoUpdatesMeansReplaceTheGadget() {
        val v = Decide.verdict(Kind.PHONE, 6.0, listOf(part("battery", Condition.REPLACEMENT_ADVISED), part("memory", Condition.WATCH)), true, 0)
        assertEquals(Action.REPLACE, v.action); assertTrue(v.score >= 4)
    }
    @Test fun noSecurityUpdatesAloneIsAReasonButTheHardwareStaysUsable() {
        val v = Decide.verdict(Kind.PC, 3.0, listOf(part("battery", Condition.HEALTHY), part("storage", Condition.HEALTHY), part("memory", Condition.HEALTHY)), true, 0)
        assertEquals(Action.REPLACE, v.action); assertTrue(v.reasons.any { it.contains("serviceable") })
    }
    @Test fun softwareProblemsOnGoodHardwareAreMaintainNotReplace() {
        assertEquals(Action.MAINTAIN, Decide.verdict(Kind.PC, 3.0, listOf(part("storage", Condition.HEALTHY), part("battery", Condition.HEALTHY), part("memory", Condition.HEALTHY)), false, 2).action)
    }
    @Test fun wearShortOfReplacementIsWatch() {
        val v = Decide.verdict(Kind.PC, 4.0, listOf(part("battery", Condition.WATCH), part("storage", Condition.HEALTHY), part("memory", Condition.HEALTHY)), false, 0)
        assertEquals(Action.MONITOR, v.action)
    }
    @Test fun twoCriticalPartsMeanReplace() {
        assertEquals(Action.REPLACE, Decide.verdict(Kind.PC, 2.0, listOf(part("storage", Condition.CRITICAL), part("battery", Condition.CRITICAL)), false, 0).action)
    }
    @Test fun unknownPartsLowerTheConfidenceInsteadOfBeingGuessed() {
        val v = Decide.verdict(Kind.PHONE, null, listOf(part("battery", Condition.NOT_MEASURED), part("storage", Condition.NOT_MEASURED), part("memory", Condition.HEALTHY)), false, 0)
        assertEquals("LOW", v.confidence)
    }
    @Test fun batteryThresholdsMatchTheWindowsRules() {
        assertEquals(Condition.HEALTHY, Decide.batteryByCapacity(80, null).first); assertEquals(Condition.WATCH, Decide.batteryByCapacity(79, null).first)
        assertEquals(Condition.REPLACEMENT_ADVISED, Decide.batteryByCapacity(64, null).first); assertEquals(Condition.CRITICAL, Decide.batteryByCapacity(49, null).first)
        assertEquals(Condition.NOT_MEASURED, Decide.batteryByCapacity(null, null).first); assertEquals(Condition.WATCH, Decide.batteryByCapacity(null, 900).first)
    }
    @Test fun driveWearAndHealthFollowTheWindowsLadder() {
        assertEquals(Condition.HEALTHY, Decide.driveByWear(5, "Healthy", null).first); assertEquals(Condition.WATCH, Decide.driveByWear(60, "Healthy", null).first)
        assertEquals(Condition.REPLACEMENT_ADVISED, Decide.driveByWear(92, null, null).first); assertEquals(Condition.CRITICAL, Decide.driveByWear(10, "Unhealthy", null).first)
        assertEquals(Condition.NOT_MEASURED, Decide.driveByWear(null, null, 4000.0).first)
    }
}
