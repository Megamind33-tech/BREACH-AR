package com.viro.workcare

import com.viro.workcare.clean.Cat
import com.viro.workcare.clean.Cleaner
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

class CleanerTests {
    private lateinit var root: File
    @Before fun setUp() { root = Files.createTempDirectory("wc-clean").toFile() }
    @After fun tearDown() { root.deleteRecursively() }
    private fun file(rel: String, bytes: Int = 10, fill: Byte = 7): File = File(root, rel).also { it.parentFile.mkdirs(); it.writeBytes(ByteArray(bytes) { fill }) }

    @Test fun findsEachKindOfLeftoverAndLeavesEverythingElseAlone() {
        file("DCIM/.thumbnails/a.jpg", 100); file(".trashed-1790000000-photo.jpg", 200); file("Download/old.apk", 300); file("Documents/work.log", 40); file("Pictures/.secret/x.bin", 55)
        File(root, "Empty/Inner").mkdirs(); file("Music/song.mp3", 500); file("Notes/keep.txt", 5)
        val r = Cleaner.scan(root)
        assertEquals(setOf("DCIM/.thumbnails", ".trashed-1790000000-photo.jpg", "Download/old.apk", "Documents/work.log", "Pictures/.secret"), r.items.filter { it.cat != Cat.EMPTY }.map { File(it.path).relativeTo(root).path.replace('\\', '/') }.toSet())
        assertEquals(Cat.THUMBS, r.items.first { it.path.endsWith(".thumbnails") }.cat); assertEquals(Cat.TRASH, r.items.first { it.path.contains(".trashed-") }.cat); assertEquals(Cat.HIDDEN, r.items.first { it.path.endsWith(".secret") }.cat)
        assertEquals(55L, r.items.first { it.path.endsWith(".secret") }.bytes)
        assertTrue(r.items.none { it.path.endsWith("song.mp3") || it.path.endsWith("keep.txt") })
        assertTrue(r.of(Cat.EMPTY).any { it.path.endsWith("Inner") })
    }

    @Test fun scanningNeverDeletesAnything() {
        val f = file(".hidden/a.bin", 99); Cleaner.scan(root); assertTrue(f.exists())
    }

    @Test fun noMediaMarkersAndTheAndroidFolderAreNeverReported() {
        file("Pics/.nomedia", 0); file("Android/data/com.x/.cache/y.bin", 50); file("Android/.hidden", 5)
        val r = Cleaner.scan(root); assertTrue(r.items.none { it.path.contains("Android") || it.path.endsWith(".nomedia") })
    }

    @Test fun duplicatesKeepTheOldestCopy() {
        val a = file("A/one.bin", 2 * 1024 * 1024, 9); a.setLastModified(1_000_000); val b = file("B/two.bin", 2 * 1024 * 1024, 9); b.setLastModified(2_000_000); file("C/other.bin", 2 * 1024 * 1024, 3)
        val r = Cleaner.scan(root); val d = r.of(Cat.DUPLICATE); assertEquals(1, d.size); assertTrue(d[0].path.endsWith("two.bin"))
    }

    @Test fun deletionIsPermanentAndReportsWhatReallyHappened() {
        val a = file(".hidden/a.bin", 1000); val b = file("Download/x.apk", 500); val keep = file("Docs/keep.txt", 5)
        val items = Cleaner.scan(root).items; val res = Cleaner.delete(root, items, overwrite = true)
        assertFalse(a.exists()); assertFalse(b.exists()); assertTrue(keep.exists())
        assertEquals(1500L, res.freedBytes); assertTrue(res.failed.isEmpty() && res.refused.isEmpty())
    }

    @Test fun refusesAnythingOutsideTheRootOrInAndroidOrTheRootItself() {
        val outside = Files.createTempFile("wc-outside", ".bin").toFile(); outside.writeBytes(ByteArray(10))
        val android = file("Android/data/app/f.bin", 10)
        val items = listOf(com.viro.workcare.clean.Item(outside.path, 10, Cat.TEMP, false, 0), com.viro.workcare.clean.Item(android.path, 10, Cat.TEMP, false, 0), com.viro.workcare.clean.Item(root.path, 0, Cat.EMPTY, true, 0),
            com.viro.workcare.clean.Item(File(root, "../" + outside.name).path, 10, Cat.TEMP, false, 0))
        val res = Cleaner.delete(root, items, overwrite = false)
        assertEquals(4, res.refused.size); assertTrue(outside.exists() && android.exists() && root.exists()); assertEquals(0, res.deleted)
        outside.delete()
    }

    @Test fun deletingAnAlreadyGoneItemIsNotCountedAsFreed() {
        val a = file(".h/a.bin", 100); val items = Cleaner.scan(root).items; a.parentFile.deleteRecursively()
        val res = Cleaner.delete(root, items, false); assertEquals(0, res.deleted); assertEquals(0L, res.freedBytes)
    }
}
