package com.viro.workcare

import com.viro.workcare.data.EvidenceType
import com.viro.workcare.data.Severity
import com.viro.workcare.data.Tier
import com.viro.workcare.phone.AuditCatalog
import com.viro.workcare.phone.PhoneDeep
import com.viro.workcare.phone.PhoneDeepFindings
import com.viro.workcare.phone.PhoneFindings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private fun deep(over: (PhoneDeep) -> PhoneDeep = { it }) = over(PhoneDeep(
    takenAtMillis = 1_790_000_000_000L, accessibility = emptyList(), notificationListeners = emptyList(), deviceAdmins = emptyList(), userCertificates = 0, proxy = null, privateDns = "opportunistic", vpnActive = false,
    adbEnabled = false, developerOptions = false, buildTags = "release-keys", buildType = "user", rootIndicators = emptyList(), appsChecked = 10, sideloaded = emptyList(), permissionApps = mapOf("Camera" to listOf("A"), "Microphone" to emptyList())))

class DeepAuditTests {
    private fun byId(d: PhoneDeep, id: String) = PhoneDeepFindings.evaluate(d).first { it.id == id }

    @Test fun everyDeepFindingIsTaggedDeepAndEssentialsNeverAre() {
        assertTrue(PhoneDeepFindings.evaluate(deep()).all { it.tier == Tier.DEEP })
        assertTrue(PhoneFindings.evaluate(snapForDeepTests()).none { it.tier == Tier.DEEP })
    }

    @Test fun aCleanPhoneIsReportedCleanWithoutInventingWarnings() {
        val f = PhoneDeepFindings.evaluate(deep())
        assertTrue(f.all { it.severity == Severity.HEALTHY })
    }

    @Test fun anUnknownAccessibilityServiceNeedsALookButASystemOneDoesNot() {
        assertEquals(Severity.ATTENTION, byId(deep { it.copy(accessibility = listOf("com.shady.helper/.Svc")) }, "deep.accessibility").severity)
        assertEquals(Severity.HEALTHY, byId(deep { it.copy(accessibility = listOf("com.google.android.marvin.talkback/.TalkBackService")) }, "deep.accessibility").severity)
    }

    @Test fun usbDebuggingOnIsAttentionAndSaysSo() {
        val f = byId(deep { it.copy(adbEnabled = true) }, "deep.debugging")
        assertEquals(Severity.ATTENTION, f.severity); assertEquals(EvidenceType.MEASURED, f.type); assertTrue(f.action != null)
    }

    @Test fun addedCertificatesAndProxiesAreCounted() {
        assertEquals(Severity.ATTENTION, byId(deep { it.copy(userCertificates = 2) }, "deep.user_certificates").severity)
        assertEquals(Severity.HEALTHY, byId(deep(), "deep.user_certificates").severity)
        assertEquals(Severity.ATTENTION, byId(deep { it.copy(proxy = "10.0.0.5:8080") }, "deep.proxy").severity)
        assertFalse(PhoneDeepFindings.evaluate(deep()).any { it.id == "deep.proxy" })
    }

    @Test fun rootSignsAreLabelledInferredNotMeasured() {
        val f = byId(deep { it.copy(rootIndicators = listOf("/system/xbin/su")) }, "deep.build_integrity")
        assertEquals(Severity.ATTENTION, f.severity); assertEquals(EvidenceType.INFERRED, f.type)
    }

    @Test fun anOutsideStoreAppWithSensitiveAccessIsFlaggedButAnInnocentOneIsNot() {
        val bad = byId(deep { it.copy(sideloaded = listOf("Spy App"), permissionApps = mapOf("Microphone" to listOf("Spy App (outside a store)"))) }, "deep.sideloaded_sensitive")
        assertEquals(Severity.ATTENTION, bad.severity); assertTrue(bad.summary.contains("Spy App"))
        val fine = byId(deep { it.copy(sideloaded = listOf("Plain Tool"), permissionApps = mapOf("Microphone" to listOf("Some App"))) }, "deep.sideloaded_sensitive")
        assertEquals(Severity.HEALTHY, fine.severity)
    }

    @Test fun theUnlockListNamesOnlyChecksThatExistAndMatchesWhatRuns() {
        val ids = PhoneDeepFindings.evaluate(deep { it.copy(accessibility = listOf("x/y"), notificationListeners = listOf("x/y"), deviceAdmins = listOf("x/y"), proxy = "p:1") }).map { it.id }.toSet()
        // every catalogue entry is produced by the real audit (the permissions overview and proxy appear when there is something to say)
        AuditCatalog.phone.forEach { assertTrue("catalogue lists ${it.id} but the audit never produces it", it.id in ids) }
    }

    @Test fun withoutTheDeepAuditTheAppsComponentSaysItWasNotRun() {
        val h = PhoneFindings.health(snapForDeepTests())
        val apps = h.components.first { it.component.key == "apps" }
        assertTrue(apps.unavailableReason!!.contains("deep audit"))
        assertTrue(PhoneFindings.health(snapForDeepTests(), "this-phone", deep()).components.first { it.component.key == "apps" }.available)
    }
}

private const val GB2 = 1073741824L
private fun snapForDeepTests() = com.viro.workcare.phone.PhoneSnapshot(
    takenAtMillis = 1_790_000_000_000L, manufacturer = "Tecno", model = "CI6", androidRelease = "13", sdk = 33, securityPatch = "2026-07-05",
    batteryPercent = 71, batteryHealth = 2, batteryTempC = 31.0, charging = false, plugged = null, cycleCount = null, chargeCounterUah = null, capacityPercentProp = null,
    storageTotal = 128 * GB2, storageFree = 64 * GB2, memTotal = 6 * GB2, memAvail = 2 * GB2, lowMemory = false, thermalStatus = 0, secureLock = true, encryptionActive = true,
    biometricAvailable = true, network = "Wi-Fi", networkValidated = true, sensors = listOf("Accelerometer"), sensorCount = 20)
