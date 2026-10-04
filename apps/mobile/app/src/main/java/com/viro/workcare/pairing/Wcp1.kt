package com.viro.workcare.pairing

import java.math.BigInteger
import java.net.URI
import java.net.URLDecoder
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * WCP1 (phone side). Same primitives and byte layouts as packages/pairing-protocol and server/src/twin/pairing.ts: ECDH P-256, HMAC-SHA256, HKDF-SHA256, AES-256-GCM.
 * Verified against the shared fixed vectors in Wcp1Test. A session grants inspection only; it expires, is single use and can be revoked.
 */
object Wcp1 {
    const val VERSION = 1
    private val rnd = java.security.SecureRandom()
    fun b64u(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    fun unb64u(s: String): ByteArray = Base64.getUrlDecoder().decode(s)
    fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    fun unhex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    class Offer(val sessionId: ByteArray, val pcPub: ByteArray, val expiresAt: Long, val secret: ByteArray, val hints: List<String>)
    class Hello(val phonePub: ByteArray, val nonceP: ByteArray, val proof: ByteArray)
    class Accept(val nonceC: ByteArray, val proof: ByteArray)
    class Keys(val clientKey: ByteArray, val serverKey: ByteArray, val sas: String)
    class PairingException(message: String) : Exception(message)

    fun parseOffer(url: String): Offer {
        val u = try { URI(url) } catch (e: Exception) { throw PairingException("This is not a WorkCare pairing code") }
        if (u.scheme != "workcare" || u.host != "pair") throw PairingException("This is not a WorkCare pairing code")
        val q = (u.rawQuery ?: "").split('&').filter { it.contains('=') }.associate { it.substringBefore('=') to URLDecoder.decode(it.substringAfter('='), "UTF-8") }
        if (q["v"] != "1") throw PairingException("This pairing code needs a newer WorkCare")
        fun need(k: String) = q[k] ?: throw PairingException("The pairing code is incomplete")
        val offer = try { Offer(unb64u(need("s")), unb64u(need("k")), need("e").toLong(), unb64u(need("q")), (q["h"] ?: "").split(',').filter { it.isNotEmpty() }) } catch (e: PairingException) { throw e } catch (e: Exception) { throw PairingException("The pairing code is damaged") }
        if (offer.sessionId.size != 16 || offer.pcPub.size != 65 || offer.secret.size != 16) throw PairingException("The pairing code is damaged")
        return offer
    }

    fun secretFromCode(code: String): ByteArray = hmac("WCP1 code".toByteArray(), code.filter { it.isDigit() }.toByteArray()).copyOfRange(0, 16)

    // ------------------------------------------------------------------------------------------ crypto helpers
    private fun sha256(vararg parts: ByteArray): ByteArray { val d = MessageDigest.getInstance("SHA-256"); parts.forEach { d.update(it) }; return d.digest() }
    fun hmac(key: ByteArray, vararg parts: ByteArray): ByteArray { val m = Mac.getInstance("HmacSHA256"); m.init(SecretKeySpec(key, "HmacSHA256")); parts.forEach { m.update(it) }; return m.doFinal() }
    private fun s(x: String) = x.toByteArray(Charsets.UTF_8)
    fun hkdf(ikm: ByteArray, salt: ByteArray, info: String, length: Int): ByteArray {
        val prk = hmac(salt, ikm); val out = java.io.ByteArrayOutputStream(); var t = ByteArray(0); var i = 1
        while (out.size() < length) { t = hmac(prk, t, s(info), byteArrayOf(i.toByte())); out.write(t); i++ }
        return out.toByteArray().copyOf(length)
    }
    private val params: ECParameterSpec by lazy { val p = AlgorithmParameters.getInstance("EC"); p.init(ECGenParameterSpec("secp256r1")); p.getParameterSpec(ECParameterSpec::class.java) }
    fun publicFromBytes(raw: ByteArray): java.security.PublicKey {
        if (raw.size != 65 || raw[0] != 4.toByte()) throw PairingException("Invalid public key")
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65))), params))
    }
    fun privateFromScalar(scalar: ByteArray): PrivateKey = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, scalar), params))
    fun publicBytes(k: ECPublicKey): ByteArray {
        fun fix(b: BigInteger): ByteArray { val x = b.toByteArray(); return if (x.size == 33) x.copyOfRange(1, 33) else ByteArray(32 - x.size) + x }
        return byteArrayOf(4) + fix(k.w.affineX) + fix(k.w.affineY)
    }
    private fun ecdh(priv: PrivateKey, pubRaw: ByteArray): ByteArray { val ka = KeyAgreement.getInstance("ECDH"); ka.init(priv); ka.doPhase(publicFromBytes(pubRaw), true); return ka.generateSecret() }

    private fun helloProof(q: ByteArray, sid: ByteArray, pcPub: ByteArray, phonePub: ByteArray, nonceP: ByteArray) = hmac(q, s("hello"), sid, pcPub, phonePub, nonceP)
    private fun acceptProof(q: ByteArray, sid: ByteArray, pcPub: ByteArray, phonePub: ByteArray, nonceP: ByteArray, nonceC: ByteArray) = hmac(q, s("accept"), sid, pcPub, phonePub, nonceP, nonceC)
    fun deriveKeys(shared: ByteArray, q: ByteArray, sid: ByteArray, nonceP: ByteArray, nonceC: ByteArray): Keys {
        val salt = sha256(sid, nonceP, nonceC); val ikm = shared + q
        val okm = hkdf(ikm, salt, "WCP1 keys", 64); val sasBytes = hkdf(ikm, salt, "WCP1 sas", 4)
        val sas = (BigInteger(1, sasBytes).mod(BigInteger.valueOf(1_000_000))).toString().padStart(6, '0')
        return Keys(okm.copyOfRange(0, 32), okm.copyOfRange(32, 64), sas)
    }

    /** One pairing attempt from the phone. Pass fixed values only in tests. */
    class Handshake(private val offer: Offer, fixedPrivate: ByteArray? = null, fixedPublic: ByteArray? = null, fixedNonce: ByteArray? = null) {
        private val priv: PrivateKey; val hello: Hello
        init {
            val phonePub: ByteArray
            if (fixedPrivate != null && fixedPublic != null) { priv = privateFromScalar(fixedPrivate); phonePub = fixedPublic }
            else { val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair(); priv = kp.private; phonePub = publicBytes(kp.public as ECPublicKey) }
            val nonceP = fixedNonce ?: ByteArray(16).also { rnd.nextBytes(it) }
            hello = Hello(phonePub, nonceP, helloProof(offer.secret, offer.sessionId, offer.pcPub, phonePub, nonceP))
        }
        fun finish(accept: Accept): Keys {
            val want = acceptProof(offer.secret, offer.sessionId, offer.pcPub, hello.phonePub, hello.nonceP, accept.nonceC)
            if (!MessageDigest.isEqual(want, accept.proof)) throw PairingException("The computer did not prove it holds this pairing code")
            return deriveKeys(ecdh(priv, offer.pcPub), offer.secret, offer.sessionId, hello.nonceP, accept.nonceC)
        }
    }

    // ------------------------------------------------------------------------------------------ frames
    private fun nonceOf(dir: Int, counter: Long): ByteArray { val n = java.nio.ByteBuffer.allocate(12); n.putInt(dir); n.putLong(counter); return n.array() }
    private fun aadOf(sid: ByteArray, dir: Int, counter: Long): ByteArray { val a = java.nio.ByteBuffer.allocate(25); a.put(sid); a.put(dir.toByte()); a.putLong(counter); return a.array() }
    fun seal(key: ByteArray, sid: ByteArray, dir: Int, counter: Long, plaintext: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonceOf(dir, counter))); c.updateAAD(aadOf(sid, dir, counter))
        return java.nio.ByteBuffer.allocate(8).putLong(counter).array() + c.doFinal(plaintext)
    }
    fun open(key: ByteArray, sid: ByteArray, dir: Int, frame: ByteArray): Pair<Long, ByteArray> {
        if (frame.size < 24) throw PairingException("Frame too short")
        val counter = java.nio.ByteBuffer.wrap(frame, 0, 8).long
        val c = Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonceOf(dir, counter))); c.updateAAD(aadOf(sid, dir, counter))
        return counter to c.doFinal(frame, 8, frame.size - 8)
    }
    const val C2S = 1; const val S2C = 2

    /** Client side of an established session: strictly increasing counters in both directions, so a replayed or reordered frame is refused. */
    class Channel(private val keys: Keys, private val sid: ByteArray) {
        private var sendCounter = 0L; private var lastSeen = -1L
        fun send(plain: ByteArray): ByteArray = seal(keys.clientKey, sid, C2S, sendCounter++, plain)
        fun receive(frame: ByteArray): ByteArray {
            val (counter, plain) = open(keys.serverKey, sid, S2C, frame)
            if (counter <= lastSeen) throw PairingException("Replayed or out-of-order frame")
            lastSeen = counter; return plain
        }
    }
}
