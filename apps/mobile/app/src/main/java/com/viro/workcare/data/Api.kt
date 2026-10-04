package com.viro.workcare.data

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Secrets (the sign-in token) are encrypted with a key that never leaves the Android Keystore. Nothing sensitive is written to logs or plain preferences. */
class SecureStore(ctx: Context) {
    private val prefs: SharedPreferences = ctx.getSharedPreferences("wc_secure", Context.MODE_PRIVATE)
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey("workcare_secure_v1", null) as? SecretKey)?.let { return it }
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        g.init(KeyGenParameterSpec.Builder("workcare_secure_v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        return g.generateKey()
    }
    fun put(name: String, value: String?) {
        if (value == null) { prefs.edit().remove(name).apply(); return }
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        prefs.edit().putString(name, Base64.encodeToString(c.iv + c.doFinal(value.toByteArray()), Base64.NO_WRAP)).apply()
    }
    fun get(name: String): String? {
        val stored = prefs.getString(name, null) ?: return null
        return try {
            val raw = Base64.decode(stored, Base64.NO_WRAP)
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12)) }.doFinal(raw, 12, raw.size - 12).toString(Charsets.UTF_8)
        } catch (e: Exception) { null }
    }
}

class ApiError(val status: Int, message: String, val code: String? = null) : Exception(message)
sealed class LoginResult { class Ok(val token: String, val role: String) : LoginResult(); object MfaRequired : LoginResult(); class MfaSetupRequired(val token: String) : LoginResult() }

/** Only https is accepted for the Control server, except for an address on this device's own or a private network (a lab server). */
fun isAllowedServer(url: String): Boolean = try {
    val u = URL(url); u.protocol == "https" || (u.protocol == "http" && isPrivateHost(u.host))
} catch (e: Exception) { false }
fun isPrivateHost(host: String): Boolean {
    if (host == "localhost" || host.endsWith(".local")) return true
    val a = try { InetAddress.getByName(host) } catch (e: Exception) { return false }
    return a.isLoopbackAddress || a.isSiteLocalAddress || a.isLinkLocalAddress
}

class ControlApi(private val baseUrl: String, private val token: () -> String?) {
    private fun call(method: String, path: String, body: JSONObject? = null): JSONObject {
        if (!isAllowedServer(baseUrl)) throw ApiError(0, "The server address must use https.")
        val c = (URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection)
        try {
            c.requestMethod = method; c.connectTimeout = 8000; c.readTimeout = 20000; c.setRequestProperty("accept", "application/json")
            token()?.let { c.setRequestProperty("authorization", "Bearer $it") }
            if (body != null) { c.doOutput = true; c.setRequestProperty("content-type", "application/json"); c.outputStream.use { it.write(body.toString().toByteArray()) } }
            val code = c.responseCode
            val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""
            val json = try { if (text.isBlank()) JSONObject() else JSONObject(text) } catch (e: Exception) { JSONObject() }
            if (code !in 200..299) throw ApiError(code, json.optString("message").ifEmpty { json.optString("error").ifEmpty { "Request failed ($code)" } }, json.optString("error").ifEmpty { null })
            return json
        } finally { c.disconnect() }
    }
    private suspend fun io(method: String, path: String, body: JSONObject? = null) = withContext(Dispatchers.IO) { call(method, path, body) }

    suspend fun login(email: String, password: String, code: String?): LoginResult = withContext(Dispatchers.IO) {
        try {
            val r = call("POST", "/api/v1/auth/login", JSONObject().put("email", email).put("password", password).apply { if (!code.isNullOrBlank()) put("code", code) })
            if (r.optBoolean("mfaSetupRequired")) LoginResult.MfaSetupRequired(r.getString("token")) else LoginResult.Ok(r.getString("token"), r.optString("role"))
        } catch (e: ApiError) { if (e.code == "mfa_required") LoginResult.MfaRequired else throw e }
    }
    suspend fun devicesRaw(): JSONObject = io("GET", "/api/v1/twin/devices")
    suspend fun deviceRaw(id: String): JSONObject = io("GET", "/api/v1/twin/devices/$id")
    suspend fun alertsRaw(): JSONObject = io("GET", "/api/v1/twin/alerts")
    suspend fun passport(id: String): List<PassportEvent> = parsePassport(io("GET", "/api/v1/twin/devices/$id/passport"))
    suspend fun compute(id: String): ComputeStatus = parseCompute(io("GET", "/api/v1/twin/devices/$id/compute"))
    suspend fun pauseCompute(id: String, minutes: Int): ComputeStatus = parseCompute(io("POST", "/api/v1/twin/devices/$id/compute/pause", JSONObject().put("minutes", minutes)))
    suspend fun resumeCompute(id: String): ComputeStatus = parseCompute(io("POST", "/api/v1/twin/devices/$id/compute/resume", JSONObject()))
    suspend fun runQuickScan(id: String) = io("POST", "/api/v1/twin/devices/$id/commands", JSONObject().put("capability", "RUN_QUICK_SCAN"))
    suspend fun runTest(id: String, test: String) = io("POST", "/api/v1/twin/devices/$id/commands", JSONObject().put("capability", "RUN_APPROVED_TEST").put("test", test))
}
