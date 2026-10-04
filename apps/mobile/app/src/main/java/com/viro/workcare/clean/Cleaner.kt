package com.viro.workcare.clean

import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

/** What kind of leftover an item is. [selected] says whether it is ticked by default: only things that are leftovers by nature are. */
enum class Cat(val label: String, val why: String, val selected: Boolean) {
    TRASH("Deleted items still stored", "Items you deleted that Android keeps in a recycle bin until it empties itself.", true),
    THUMBS("Thumbnail caches", "Small preview pictures that apps rebuild when needed.", true),
    HIDDEN("Hidden files and folders", "Files and folders whose names start with a dot, so file managers hide them. Check the list before deleting.", false),
    TEMP("Temporary and log files", "Files with .tmp, .temp, .log, .bak or .cache endings.", true),
    APK("Installer files (APK)", "Installers you downloaded. Apps already installed do not need them.", false),
    EMPTY("Empty folders", "Folders with nothing in them.", true),
    LARGE("Large files", "Single files over 200 MB. You decide: these may be videos or backups you want.", false),
    DUPLICATE("Duplicate files", "Files with identical content. The oldest copy is kept; the others are listed.", false),
}

data class Item(val path: String, val bytes: Long, val cat: Cat, val isDir: Boolean, val modified: Long)
data class ScanReport(val items: List<Item>, val filesLooked: Long, val folders: Long, val ms: Long, val stoppedEarly: Boolean) {
    fun of(c: Cat) = items.filter { it.cat == c }
    fun bytes(c: Cat) = of(c).sumOf { it.bytes }
}
data class DeleteResult(val deleted: Int, val freedBytes: Long, val failed: List<String>, val refused: List<String>)

/**
 * Finds and permanently deletes leftovers in the phone's shared storage ([root]).
 * Safety rules, enforced in code and tested:
 *  - nothing outside [root] is ever touched, and neither is [root] itself, or the Android/ folder (other apps' private areas);
 *  - nothing is deleted unless the caller passes it in: scanning never deletes;
 *  - a path is re-checked at deletion time (it must resolve inside root and not through a symbolic link);
 *  - ".nomedia" markers are never reported, because deleting one makes a hidden folder appear in the gallery.
 */
object Cleaner {
    private const val LARGE = 200L * 1024 * 1024
    private const val DUP_MIN = 1L * 1024 * 1024
    private val tempExt = setOf("tmp", "temp", "log", "bak", "cache", "crdownload", "part")

    fun scan(root: File, maxMs: Long = 60_000, progress: (files: Long, folder: String) -> Unit = { _, _ -> }, cancelled: () -> Boolean = { false }): ScanReport {
        val start = System.currentTimeMillis(); val items = ArrayList<Item>(); var files = 0L; var folders = 0L; var stopped = false
        val bySize = HashMap<Long, MutableList<File>>()
        fun over() = cancelled() || System.currentTimeMillis() - start > maxMs

        fun sizeOf(f: File): Long { if (f.isFile) return f.length(); var n = 0L; f.walkTopDown().onEnter { !isLink(it) }.forEach { if (it.isFile) n += it.length() }; return n }
        fun hiddenCat(name: String): Cat = when {
            name.startsWith(".trashed-") || name.equals(".trash", true) || name.equals(".Trash", true) || name.equals(".recycle", true) -> Cat.TRASH
            name.contains("thumb", true) || name.equals(".cache", true) -> Cat.THUMBS
            else -> Cat.HIDDEN
        }
        fun hasFile(d: File): Boolean = d.walkTopDown().onEnter { !isLink(it) }.any { it.isFile }

        fun walk(dir: File, top: Boolean) {
            if (over()) { stopped = true; return }
            val kids = try { dir.listFiles() } catch (e: Exception) { null } ?: return
            folders++; progress(files, dir.name)
            var empty = kids.isNotEmpty().not()
            for (k in kids) {
                if (over()) { stopped = true; return }
                if (isLink(k)) continue
                val n = k.name
                if (top && n == "Android") continue
                if (n == ".nomedia") { empty = false; continue }
                if (n.startsWith(".")) {
                    empty = false
                    val sz = try { sizeOf(k) } catch (e: Exception) { 0L }
                    items.add(Item(k.path, sz, hiddenCat(n), k.isDirectory, k.lastModified())); files++
                    continue
                }
                if (k.isDirectory) { walk(k, false); empty = false; continue }
                files++; empty = false
                val ext = n.substringAfterLast('.', "").lowercase(); val len = k.length()
                when {
                    ext == "apk" -> items.add(Item(k.path, len, Cat.APK, false, k.lastModified()))
                    ext in tempExt -> items.add(Item(k.path, len, Cat.TEMP, false, k.lastModified()))
                    len >= LARGE -> items.add(Item(k.path, len, Cat.LARGE, false, k.lastModified()))
                }
                if (len >= DUP_MIN) bySize.getOrPut(len) { ArrayList() }.add(k)
            }
            if (!top && kids.none { it.name != ".nomedia" } && dir.listFiles()?.isEmpty() == true) items.add(Item(dir.path, 0, Cat.EMPTY, true, dir.lastModified()))
        }
        walk(root, true)

        // duplicates: same size, then same content fingerprint (head + tail), then confirmed by full compare of the survivors' hash
        if (!stopped) for ((_, group) in bySize) {
            if (group.size < 2 || over()) { if (over()) stopped = true; continue }
            val byPrint = group.groupBy { fingerprint(it) }
            for ((_, same) in byPrint) {
                if (same.size < 2) continue
                val sorted = same.sortedBy { it.lastModified() }
                val keep = sorted.first()
                for (d in sorted.drop(1)) if (identical(keep, d) && items.none { it.path == d.path && it.cat != Cat.DUPLICATE }) items.add(Item(d.path, d.length(), Cat.DUPLICATE, false, d.lastModified()))
            }
        }
        return ScanReport(items, files, folders, System.currentTimeMillis() - start, stopped)
    }

    private fun isLink(f: File) = try { f.canonicalPath != File(f.parentFile?.canonicalFile ?: f.absoluteFile.parentFile, f.name).path } catch (e: Exception) { true }

    private fun fingerprint(f: File): String = try {
        val md = MessageDigest.getInstance("SHA-1"); val buf = ByteArray(65536)
        RandomAccessFile(f, "r").use { r -> var n = r.read(buf); if (n > 0) md.update(buf, 0, n); if (r.length() > 131072) { r.seek(r.length() - 65536); n = r.read(buf); if (n > 0) md.update(buf, 0, n) } }
        md.digest().joinToString("") { "%02x".format(it) } } catch (e: Exception) { f.path }

    private fun identical(a: File, b: File): Boolean = try {
        if (a.length() != b.length()) false else a.inputStream().buffered().use { x -> b.inputStream().buffered().use { y -> var ok = true; while (true) { val p = x.read(); val q = y.read(); if (p != q) { ok = false; break }; if (p < 0) break }; ok } }
    } catch (e: Exception) { false }

    /** Whether [f] may be deleted: inside [root], not root, not under Android/, and not reached through a link. */
    fun allowed(root: File, f: File): Boolean = try {
        val r = root.canonicalFile; val c = f.canonicalFile
        c.path != r.path && c.path.startsWith(r.path + File.separator) && !c.path.startsWith(File(r, "Android").path + File.separator) && c.path != File(r, "Android").path && !isLink(f)
    } catch (e: Exception) { false }

    /**
     * Permanently deletes [items]. With [overwrite], file contents are overwritten with zeros first (best effort: flash storage may keep old blocks, but phone storage is
     * encrypted, so removed data cannot be read back without the key). Returns what really happened, checked by looking again.
     */
    fun delete(root: File, items: List<Item>, overwrite: Boolean, progress: (done: Int, total: Int) -> Unit = { _, _ -> }): DeleteResult {
        var freed = 0L; var ok = 0; val failed = ArrayList<String>(); val refused = ArrayList<String>()
        items.forEachIndexed { i, it ->
            val f = File(it.path)
            if (!allowed(root, f)) refused.add(it.path)
            else if (!f.exists()) { /* already gone */ }
            else {
                val before = try { if (f.isDirectory) f.walkTopDown().filter { x -> x.isFile }.sumOf { x -> x.length() } else f.length() } catch (e: Exception) { 0L }
                if (overwrite) try { (if (f.isDirectory) f.walkTopDown().filter { x -> x.isFile }.toList() else listOf(f)).forEach { x -> zero(x) } } catch (e: Exception) { }
                val gone = try { if (f.isDirectory) f.deleteRecursively() else f.delete() } catch (e: Exception) { false }
                if (gone && !f.exists()) { ok++; freed += before } else failed.add(it.path)
            }
            progress(i + 1, items.size)
        }
        return DeleteResult(ok, freed, failed, refused)
    }

    private fun zero(f: File) { if (f.length() > 512L * 1024 * 1024) return; RandomAccessFile(f, "rw").use { r -> val z = ByteArray(65536); var left = r.length(); r.seek(0); while (left > 0) { val n = minOf(left, z.size.toLong()).toInt(); r.write(z, 0, n); left -= n }; r.fd.sync() } }
}
