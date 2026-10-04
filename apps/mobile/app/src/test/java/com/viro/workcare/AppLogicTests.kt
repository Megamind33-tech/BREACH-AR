package com.viro.workcare

import com.viro.workcare.data.ContractException
import com.viro.workcare.data.EvidenceType
import com.viro.workcare.data.Freshness
import com.viro.workcare.data.Severity
import com.viro.workcare.data.parseDeviceHealth
import com.viro.workcare.data.parseDevices
import com.viro.workcare.data.isAllowedServer
import com.viro.workcare.data.isPrivateHost
import com.viro.workcare.pairing.parseScanProgress
import com.viro.workcare.phone.PhoneFindings
import com.viro.workcare.phone.PhoneSnapshot
import com.viro.workcare.rescue.RescueRules
import com.viro.workcare.rescue.Symptom
import com.viro.workcare.rules.RulesEngine
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private const val GB = 1073741824L
private fun snap(over: (PhoneSnapshot) -> PhoneSnapshot = { it }) = over(PhoneSnapshot(
    takenAtMillis = 1_790_000_000_000L, manufacturer = "Tecno", model = "CI6", androidRelease = "13", sdk = 33, securityPatch = "2026-07-05",
    batteryPercent = 71, batteryHealth = 2, batteryTempC = 31.0, charging = false, plugged = null, cycleCount = null, chargeCounterUah = null, capacityPercentProp = null,
    storageTotal = 128 * GB, storageFree = 64 * GB, memTotal = 6 * GB, memAvail = 2 * GB, lowMemory = false, thermalStatus = 0, secureLock = true, encryptionActive = true, biometricAvailable = true,
    network = "Wi-Fi", networkValidated = true, sensors = listOf("Accelerometer"), sensorCount = 20))

class AppLogicTests {
    @Test fun aHealthyPhoneHasNoWarningsAndTheHeadlineSaysSo() {
        val h = PhoneFindings.health(snap())
        assertEquals(Severity.HEALTHY, h.status); assertEquals("Working normally", h.headline); assertTrue(h.findings.none { it.severity != Severity.HEALTHY })
    }
    @Test fun androidDoesNotExposeBatteryDesignCapacityAndTheAppsListSoTheyAreMarkedNotAvailableNotInvented() {
        val h = PhoneFindings.health(snap { it.copy(batteryHealth = null) })
        val battery = h.components.first { it.component.key == "battery" }; assertNull(battery.severity); assertEquals("Android does not share the battery's original capacity with apps", battery.unavailableReason)
        val apps = h.components.first { it.component.key == "apps" }; assertNull(apps.severity); assertTrue(h.notMeasured.any { it.startsWith("Apps") })
        assertTrue(PhoneFindings.evaluate(snap { it.copy(batteryHealth = null) }).none { it.id.startsWith("battery.capacity") })
    }
    @Test fun storageThresholdsAndEvidence() {
        val f = { free: Long -> PhoneFindings.evaluate(snap { it.copy(storageFree = free) }).first { it.id == "storage.free_space" } }
        assertEquals(Severity.HEALTHY, f(20 * GB).severity); assertEquals(Severity.ATTENTION, f(9 * GB).severity); assertEquals(Severity.CRITICAL, f(5 * GB).severity)
        val a = f(9 * GB); assertEquals(EvidenceType.MEASURED, a.type); assertTrue(a.summary.contains("9.0 GB free of 128.0 GB")); assertTrue(a.evidence.any { it.name == "freePercent" })
    }
    @Test fun securityAndBatteryConditions() {
        assertEquals(Severity.ATTENTION, PhoneFindings.evaluate(snap { it.copy(secureLock = false) }).first { it.id == "security.screen_lock" }.severity)
        assertEquals(Severity.CRITICAL, PhoneFindings.evaluate(snap { it.copy(batteryHealth = 4) }).first { it.id == "battery.health" }.severity)
        assertEquals(Severity.CRITICAL, PhoneFindings.evaluate(snap { it.copy(batteryTempC = 52.0) }).first { it.id == "battery.temperature" }.severity)
        val old = PhoneFindings.evaluate(snap { it.copy(securityPatch = "2024-01-01") }).first { it.id == "system.security_patch" }
        assertEquals(Severity.CRITICAL, old.severity); assertTrue(old.summary.contains("days old"))
        assertNull(PhoneFindings.patchAgeDays("garbage", 0))
    }
    @Test fun rescueFindsTheCauseFromRealFindingsAndRulesOutWhatLooksFine() {
        val h = PhoneFindings.health(snap { it.copy(storageFree = 4 * GB, batteryTempC = 31.0) })
        val o = RescueRules.evaluate(Symptom.STORAGE, h)
        assertTrue(o.causeFound); assertEquals("Storage is nearly full", o.title); assertTrue(o.evidence.isNotEmpty()); assertTrue(o.steps.isNotEmpty())
        val hot = RescueRules.evaluate(Symptom.HOT, PhoneFindings.health(snap()))
        assertFalse("nothing is hot, so no cause is claimed", hot.causeFound); assertEquals("No clear cause found", hot.title); assertTrue(hot.notMeasured.isNotEmpty())
    }
    @Test fun rescueNeverClaimsToMeasureInternetSpeed() {
        val o = RescueRules.evaluate(Symptom.INTERNET, PhoneFindings.health(snap())); assertFalse(o.causeFound); assertEquals("Not measured", o.honestLimit); assertTrue(o.title.contains("cannot test"))
    }
    @Test fun sharedRulesDriveAPcRescueAndThermalCauseRulesOutMemory() {
        val rules = RulesEngine(AppLogicTests::class.java.classLoader!!.getResourceAsStream("rules.json")!!.bufferedReader().readText())
        val findings = rules.evaluate(JSONObject("""{"schemaVersion":1,"cpu":{"peakTempC":96,"throttled":true,"usagePercent":38},"memory":{"totalBytes":17179869184}}""")).findings
        val json = JSONObject().put("schemaVersion", 1).put("deviceId", "pc").put("status", "attention").put("headline", "x").put("components", org.json.JSONArray()).put("notMeasured", org.json.JSONArray())
            .put("findings", org.json.JSONArray(findings.map { f -> JSONObject().put("id", f.id).put("component", f.component.key).put("severity", f.severity.name.lowercase()).put("title", f.title).put("summary", f.summary).put("evidenceType", f.type.name.lowercase()).put("evidence", org.json.JSONArray(f.evidence.map { e -> JSONObject().put("name", e.name).put("value", e.value) })).put("recommendedAction", f.action ?: JSONObject.NULL) }))
        val o = RescueRules.evaluate(Symptom.SLOW, parseDeviceHealth(json))
        assertTrue(o.causeFound); assertTrue(o.ruledOut.contains("Memory capacity adequate")); assertTrue(o.finding!!.id.startsWith("cpu."))
    }
    @Test fun contractsRefuseAnUnknownSchemaVersionAndIgnoreUnknownFields() {
        val ok = JSONObject("""{"devices":[{"schemaVersion":1,"deviceId":"d1","name":"Office PC","status":"attention","headline":"Storage is almost full","freshness":"recent","kind":"pc","extra":"ignored"}]}""")
        val d = parseDevices(ok).single(); assertEquals("Office PC", d.name); assertEquals(Severity.ATTENTION, d.status); assertEquals(Freshness.RECENT, d.freshness)
        try { parseDevices(JSONObject("""{"devices":[{"schemaVersion":2,"deviceId":"d1","name":"x","status":"healthy","headline":"x","freshness":"live"}]}""")); fail("accepted a newer schema") } catch (e: ContractException) { assertTrue(e.message!!.contains("different WorkCare data versions")) }
        assertEquals(4, parseScanProgress(JSONObject("""{"scanId":"s","stages":[{"id":"a","label":"A","state":"done"},{"id":"b","label":"B","state":"running"}],"completedStages":1,"totalStages":4,"finished":false}""")).total)
    }
    @Test fun theServerAddressMustBeHttpsUnlessItIsAPrivateNetwork() {
        assertTrue(isAllowedServer("https://control.viro3.online")); assertFalse(isAllowedServer("http://control.viro3.online")); assertFalse(isAllowedServer("ftp://x")); assertTrue(isAllowedServer("http://192.168.1.20:8080")); assertTrue(isAllowedServer("http://localhost:8080"))
        assertTrue(isPrivateHost("10.0.0.5")); assertFalse(isPrivateHost("8.8.8.8"))
    }
}
