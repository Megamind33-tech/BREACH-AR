package com.viro.workcare.photos

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest

/** How close the picture is to the actual gadget. The screen always says which one it is: a photo is never presented as more exact than it is. */
enum class PhotoKind(val label: String) {
    OWN("Your photo"), EXACT("Exact model"), SIMILAR("Similar model"), REPRESENTATIVE("Representative photo"),
}

class ResolvedPhoto(val kind: PhotoKind, val bitmap: Bitmap?, val credit: String?, val phone: Boolean)

/**
 * Finds the picture for one gadget, in order of how true it is:
 *  1. a photo the person added themselves (stored only on this phone);
 *  2. a real, openly licensed photograph of that exact model from Wikimedia Commons, if one exists;
 *  3. a real photograph of the same family from the same maker, labelled "Similar model";
 *  4. otherwise a representative photograph bundled with the app, labelled as such.
 * Only the maker and model name are sent to Wikimedia, only when lookup is on, and every answer (including "nothing found") is cached.
 */
object DevicePhotos {
    private const val UA = "WorkCare/0.1 (device photo lookup; https://control.viro3.online)"
    private val allowedLicences = listOf("cc0", "public domain", "cc by", "cc-by", "pd")
    private val noise = setOf("inc", "co", "ltd", "corp", "corporation", "the", "laptop", "notebook", "phone", "smartphone", "series")

    fun tokens(s: String?): List<String> = (s ?: "").lowercase().split(Regex("[^a-z0-9]+")).filter { it.isNotEmpty() && it !in noise }.distinct()

    /** "HP ProBook 430 G7" -> maker "hp", model tokens [probook, 430, g7]. A model that starts with the maker's name does not repeat it. */
    fun split(maker: String?, model: String?): Pair<String, List<String>> {
        val mt = tokens(maker); val all = tokens(model)
        val makerTok = mt.firstOrNull() ?: all.firstOrNull() ?: ""
        return makerTok to all.filter { it != makerTok }
    }

    private fun dir(ctx: Context, name: String) = File(ctx.cacheDir, name).apply { mkdirs() }
    private fun own(ctx: Context, key: String) = File(File(ctx.filesDir, "device_photos").apply { mkdirs() }, safe(key) + ".jpg")
    private fun safe(s: String) = s.replace(Regex("[^A-Za-z0-9_-]"), "_").take(60)
    private fun sha(s: String) = MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }.take(24)

    fun hasOwn(ctx: Context, key: String) = own(ctx, key).exists()
    fun removeOwn(ctx: Context, key: String) { own(ctx, key).delete() }

    /** Stores a photo the person chose, shrunk to a sensible size. Nothing leaves the phone. */
    suspend fun savePicked(ctx: Context, key: String, uri: Uri): Boolean = withContext(Dispatchers.IO) {
        try {
            val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
            var sample = 1; while (opts.outWidth / sample > 1600) sample *= 2
            val bmp = ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) } ?: return@withContext false
            own(ctx, key).outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, 86, it) }
            true
        } catch (e: Exception) { false }
    }

    suspend fun resolve(ctx: Context, key: String, maker: String?, model: String?, phone: Boolean, lookup: Boolean): ResolvedPhoto = withContext(Dispatchers.IO) {
        val mine = own(ctx, key)
        if (mine.exists()) decode(mine.readBytes())?.let { return@withContext ResolvedPhoto(PhotoKind.OWN, it, null, phone) }
        val (makerTok, modelTok) = split(maker, model)
        if (!lookup || makerTok.isEmpty()) return@withContext ResolvedPhoto(PhotoKind.REPRESENTATIVE, null, null, phone)
        cached(ctx, makerTok, modelTok, phone)?.let { return@withContext it }

        var found: ResolvedPhoto? = null
        try {
            // 1. exact: every model token must appear in the file's title.
            if (modelTok.isNotEmpty()) found = search(listOf(makerTok) + modelTok, phone) { title -> modelTok.all { it in title } && makerTok in title }?.let { ResolvedPhoto(PhotoKind.EXACT, it.first, it.second, phone) }
            // 2. same family, same maker: the first model word that is not a number ("probook", "latitude", "camon").
            if (found == null) {
                val family = modelTok.firstOrNull { it.any(Char::isLetter) && it.length > 3 }
                val q = if (family != null) listOf(makerTok, family) else listOf(makerTok, if (phone) "smartphone" else "laptop")
                found = search(q, phone) { title -> makerTok in title && (family == null || family in title) }?.let { ResolvedPhoto(PhotoKind.SIMILAR, it.first, it.second, phone) }
            }
        } catch (e: Exception) { return@withContext ResolvedPhoto(PhotoKind.REPRESENTATIVE, null, null, phone) }   // offline: try again next time, cache nothing
        store(ctx, makerTok, modelTok, phone, found)
        found ?: ResolvedPhoto(PhotoKind.REPRESENTATIVE, null, null, phone)
    }

    private fun cacheBase(ctx: Context, m: String, t: List<String>, phone: Boolean) = File(dir(ctx, "devphoto"), sha("$m|${t.joinToString(" ")}|$phone"))
    private fun cached(ctx: Context, m: String, t: List<String>, phone: Boolean): ResolvedPhoto? {
        val base = cacheBase(ctx, m, t, phone)
        val meta = File(base.path + ".json"); if (!meta.exists()) return null
        val j = try { JSONObject(meta.readText()) } catch (e: Exception) { return null }
        if (j.optBoolean("none")) return if (System.currentTimeMillis() - j.optLong("at") < 7L * 86400_000) ResolvedPhoto(PhotoKind.REPRESENTATIVE, null, null, phone) else null
        val img = File(base.path + ".jpg"); if (!img.exists()) return null
        val bmp = decode(img.readBytes()) ?: return null
        return ResolvedPhoto(PhotoKind.valueOf(j.getString("kind")), bmp, j.optString("credit").ifEmpty { null }, phone)
    }
    private fun store(ctx: Context, m: String, t: List<String>, phone: Boolean, r: ResolvedPhoto?) {
        val base = cacheBase(ctx, m, t, phone)
        if (r?.bitmap == null) { File(base.path + ".json").writeText(JSONObject().put("none", true).put("at", System.currentTimeMillis()).toString()); return }
        File(base.path + ".jpg").outputStream().use { r.bitmap.compress(Bitmap.CompressFormat.JPEG, 86, it) }
        File(base.path + ".json").writeText(JSONObject().put("kind", r.kind.name).put("credit", r.credit ?: "").toString())
    }

    private fun decode(bytes: ByteArray): Bitmap? {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
        var s = 1; while (o.outWidth / s > 1200) s *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = s })
    }

    private fun get(url: String, limit: Int = 4_000_000): ByteArray {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 6000; c.readTimeout = 10000; c.setRequestProperty("User-Agent", UA)
            if (c.responseCode != 200) throw IllegalStateException("http ${c.responseCode}")
            val out = ByteArrayOutputStream(); val buf = ByteArray(16384)
            c.inputStream.use { i -> while (true) { val n = i.read(buf); if (n < 0) break; out.write(buf, 0, n); if (out.size() > limit) throw IllegalStateException("too large") } }
            return out.toByteArray()
        } finally { c.disconnect() }
    }

    /** One Wikimedia Commons search. Returns the first photograph whose title passes [accept] and whose licence is open, with its credit line. */
    private fun search(words: List<String>, phone: Boolean, accept: (Set<String>) -> Boolean): Pair<Bitmap, String>? {
        val q = URLEncoder.encode(words.joinToString(" ") + " filetype:bitmap", "UTF-8")
        val url = "https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=12&gsrsearch=$q&prop=imageinfo&iiprop=url%7Cextmetadata%7Csize&iiurlwidth=900&format=json"
        val pages = JSONObject(String(get(url, 600_000))).optJSONObject("query")?.optJSONObject("pages") ?: return null
        val it = pages.keys()
        while (it.hasNext()) {
            val p = pages.getJSONObject(it.next()); val title = p.optString("title").removePrefix("File:").substringBeforeLast('.')
            if (!accept(tokens(title).toSet())) continue
            val info = p.optJSONArray("imageinfo")?.optJSONObject(0) ?: continue
            val meta = info.optJSONObject("extmetadata") ?: continue
            val licence = meta.optJSONObject("LicenseShortName")?.optString("value") ?: continue
            if (allowedLicences.none { licence.lowercase().startsWith(it) }) continue
            val thumb = info.optString("thumburl"); if (thumb.isEmpty()) continue
            val artist = (meta.optJSONObject("Artist")?.optString("value") ?: "").replace(Regex("<[^>]*>"), "").trim().take(60)
            val bmp = decode(get(thumb)) ?: continue
            return bmp to listOf(artist.ifEmpty { "Unknown author" }, licence, "Wikimedia Commons").joinToString(" · ")
        }
        return null
    }
}
