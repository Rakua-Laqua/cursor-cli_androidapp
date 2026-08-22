package dev.cursorremote.android.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FileReferenceParserTest {
    @Test
    fun extractsPathAndOneBasedLineRanges() {
        val plain = parseFileReferences("changed src/foo.ts today").single()
        assertEquals("src/foo.ts", plain.path)
        assertEquals(null, plain.startLine)
        assertEquals(null, plain.endLine)
        assertEquals("src/foo.ts", "changed src/foo.ts today".substring(plain.startIndex, plain.endIndex))

        val line = parseFileReferences("see src/foo.ts:120 please").single()
        assertEquals("src/foo.ts", line.path)
        assertEquals(120, line.startLine)
        assertEquals(null, line.endLine)
        assertEquals("src/foo.ts:120", "see src/foo.ts:120 please".substring(line.startIndex, line.endIndex))

        val range = parseFileReferences("see src/foo.ts:120-160 please").single()
        assertEquals("src/foo.ts", range.path)
        assertEquals(120, range.startLine)
        assertEquals(160, range.endLine)
        assertEquals("src/foo.ts:120-160", "see src/foo.ts:120-160 please".substring(range.startIndex, range.endIndex))
    }

    @Test
    fun stripsTrailingPunctuationAndReparseConcatenatedChunks() {
        val punctuated = parseFileReferences("look at src/foo.ts.").single()
        assertEquals("src/foo.ts", punctuated.path)
        assertEquals("src/foo.ts", "look at src/foo.ts.".substring(punctuated.startIndex, punctuated.endIndex))

        val rangedPunctuated = parseFileReferences("see src/foo.ts:120-160.").single()
        assertEquals("src/foo.ts", rangedPunctuated.path)
        assertEquals(120, rangedPunctuated.startLine)
        assertEquals(160, rangedPunctuated.endLine)
        assertEquals("src/foo.ts:120-160", "see src/foo.ts:120-160.".substring(rangedPunctuated.startIndex, rangedPunctuated.endIndex))

        val japanese = parseFileReferences("更新しました src/foo.ts。").single()
        assertEquals("src/foo.ts", japanese.path)

        val joined = "see src/fo" + "o.ts:12" + "0-16" + "0 here"
        val parsed = parseFileReferences(joined).single()
        assertEquals("src/foo.ts", parsed.path)
        assertEquals(120, parsed.startLine)
        assertEquals(160, parsed.endLine)
        assertEquals("src/foo.ts:120-160", joined.substring(parsed.startIndex, parsed.endIndex))
    }

    @Test
    fun rejectsUrlAbsoluteDriveParentAndInvalidRanges() {
        assertTrue(parseFileReferences("https://example.com/src/foo.ts").isEmpty())
        assertTrue(parseFileReferences("https://src/foo.ts").isEmpty())
        assertTrue(parseFileReferences("/src/foo.ts").isEmpty())
        assertTrue(parseFileReferences("C:/src/foo.ts").isEmpty())
        assertTrue(parseFileReferences("C:\\src\\foo.ts").isEmpty())
        assertTrue(parseFileReferences("../src/foo.ts").isEmpty())
        assertTrue(parseFileReferences("src/../foo.ts").isEmpty())
        assertTrue(parseFileReferences("src/foo.ts:160-120").isEmpty())
        assertTrue(parseFileReferences("src/foo.ts:0").isEmpty())
        assertTrue(parseFileReferences("src/foo.ts:2147483648").isEmpty())
        assertTrue(parseFileReferences("src/foo.ts:120-0").isEmpty())
        assertTrue(parseFileReferences("src/foo.ts:abc").isEmpty())
        assertTrue(parseFileReferences("src/foo.ts:120-").isEmpty())
        assertTrue(parseFileReferences("src/foo.ts:120-x").isEmpty())
        assertTrue(parseFileReferences("src/foo.ts:120-160x").isEmpty())
        assertTrue(parseFileReferences("see src/foo.ts:abc please").isEmpty())
    }

    @Test
    fun findsMultipleWorkspacePaths() {
        val text = "updated src/foo.ts and docs/spec.md:8-10"
        val refs = parseFileReferences(text)
        assertEquals(listOf("src/foo.ts", "docs/spec.md"), refs.map { it.path })
        assertEquals(null, refs[0].startLine)
        assertEquals(8, refs[1].startLine)
        assertEquals(10, refs[1].endLine)
    }
}
