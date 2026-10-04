package com.viro.workcare

import com.viro.workcare.data.Severity
import com.viro.workcare.pairing.Wcp1
import com.viro.workcare.rules.RulesEngine
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private fun resource(name: String) = SharedContractTests::class.java.classLoader!!.getResourceAsStream(name)!!.bufferedReader().readText()

/** The Kotlin evaluator must agree with the TypeScript reference on every shared vector. */
class SharedContractTests {
    @Test fun rulesetVersionMatches() { assertEquals(1, RulesEngine(resource("rules.json")).version) }

    @Test fun everySharedRuleVectorProducesExactlyTheExpectedFindings() {
        val engine = RulesEngine(resource("rules.json"))
        val cases = JSONObject(resource("vectors.json")).getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i); val name = c.getString("name")
            val findings = engine.evaluate(c.getJSONObject("input")).findings
            val expect = c.getJSONArray("expect")
            assertEquals(name, (0 until expect.length()).map { expect.getJSONObject(it).getString("id") }, findings.map { it.id })
            for (j in 0 until expect.length()) {
                val e = expect.getJSONObject(j); val f = findings[j]
                assertEquals("$name ${f.id} severity", e.getString("severity"), f.severity.name.lowercase())
                assertEquals("$name ${f.id} evidenceType", e.getString("evidenceType"), f.type.name.lowercase())
                val ev = e.getJSONObject("evidence")
                for (k in ev.keys()) {
                    val got = f.evidence.firstOrNull { it.name == k }?.value ?: fail("$name ${f.id}: evidence $k missing").let { "" }
                    val want = ev.get(k)
                    if (want is Number) assertEquals("$name ${f.id} $k", want.toDouble(), got.toDouble(), 1e-9) else assertEquals("$name ${f.id} $k", want.toString(), got)
                }
            }
        }
    }

    @Test fun directiveExampleBatteryAt71PercentIsAttentionMeasuredWithNoUrgencyClaim() {
        val r = RulesEngine(resource("rules.json")).evaluate(JSONObject("""{"schemaVersion":1,"battery":{"designWh":54.1,"fullChargeWh":38.4}}"""))
        val b = r.findings.single { it.id == "battery.capacity" }
        assertEquals(Severity.ATTENTION, b.severity); assertTrue(b.summary.contains("71%")); assertTrue(b.action!!.contains("not yet urgent"))
        assertTrue("unreadable inputs are skipped, not guessed", r.skipped.contains("storage.health"))
    }

    private val v = JSONObject(resource("wcp1-vectors.json")); private val inp = v.getJSONObject("inputs"); private val exp = v.getJSONObject("expected")
    private fun h(o: JSONObject, k: String) = Wcp1.unhex(o.getString(k))

    @Test fun wcp1OfferUrlParsesToTheVectorValues() {
        val o = Wcp1.parseOffer(exp.getString("offerUrl"))
        assertArrayEquals(h(inp, "sessionId"), o.sessionId); assertArrayEquals(h(exp, "pcPublicKey"), o.pcPub); assertArrayEquals(h(inp, "secret"), o.secret)
        assertEquals(inp.getLong("expiresAt"), o.expiresAt); assertEquals(listOf("lan:192.168.1.20:47821"), o.hints)
    }

    @Test fun wcp1HelloProofSharedKeysSasAndFramesMatchTheReference() {
        val offer = Wcp1.parseOffer(exp.getString("offerUrl"))
        val hs = Wcp1.Handshake(offer, h(inp, "phonePrivateKey"), h(exp, "phonePublicKey"), h(inp, "nonceP"))
        assertArrayEquals(h(exp, "helloProof"), hs.hello.proof)
        val keys = hs.finish(Wcp1.Accept(h(inp, "nonceC"), h(exp, "acceptProof")))
        assertArrayEquals(h(exp, "clientKey"), keys.clientKey); assertArrayEquals(h(exp, "serverKey"), keys.serverKey); assertEquals(exp.getString("sas"), keys.sas)
        val sid = h(inp, "sessionId")
        val f0 = exp.getJSONObject("frameClientToServerCounter0")
        assertArrayEquals(h(f0, "frame"), Wcp1.seal(keys.clientKey, sid, Wcp1.C2S, 0, f0.getString("plaintextUtf8").toByteArray()))
        val f5 = exp.getJSONObject("frameServerToClientCounter5")
        val (counter, plain) = Wcp1.open(keys.serverKey, sid, Wcp1.S2C, h(f5, "frame"))
        assertEquals(5L, counter); assertEquals(f5.getString("plaintextUtf8"), String(plain))
        assertArrayEquals(h(exp.getJSONObject("secretFromCode"), "secret"), Wcp1.secretFromCode(exp.getJSONObject("secretFromCode").getString("code")))
    }

    @Test fun wcp1RefusesAComputerThatDoesNotHoldThePairingSecretAndRejectsReplayedFrames() {
        val offer = Wcp1.parseOffer(exp.getString("offerUrl"))
        val hs = Wcp1.Handshake(offer, h(inp, "phonePrivateKey"), h(exp, "phonePublicKey"), h(inp, "nonceP"))
        try { hs.finish(Wcp1.Accept(h(inp, "nonceC"), ByteArray(32))); fail("accepted a bad proof") } catch (e: Wcp1.PairingException) { assertTrue(e.message!!.contains("did not prove")) }
        val keys = hs.finish(Wcp1.Accept(h(inp, "nonceC"), h(exp, "acceptProof"))); val sid = h(inp, "sessionId")
        val ch = Wcp1.Channel(keys, sid)
        val f1 = Wcp1.seal(keys.serverKey, sid, Wcp1.S2C, 1, "a".toByteArray()); val f2 = Wcp1.seal(keys.serverKey, sid, Wcp1.S2C, 2, "b".toByteArray())
        assertEquals("b", String(ch.receive(f2)))
        try { ch.receive(f1); fail("accepted an older counter") } catch (e: Wcp1.PairingException) { }
        val tampered = f2.copyOf().also { it[10] = (it[10].toInt() xor 1).toByte() }
        try { Wcp1.open(keys.serverKey, sid, Wcp1.S2C, tampered); fail("accepted a tampered frame") } catch (e: javax.crypto.AEADBadTagException) { }
        try { Wcp1.parseOffer("https://evil.example/pair?v=1"); fail() } catch (e: Wcp1.PairingException) { }
    }
}
