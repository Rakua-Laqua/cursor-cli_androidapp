package dev.cursorremote.android.ui

import dev.cursorremote.android.data.protocol.SessionContextUsage
import org.junit.Assert.assertEquals
import org.junit.Test

class ContextUsageFormatterTest {
    @Test
    fun compactCountsAndZeroSizeOmitPercent() {
        assertEquals("0 / 0", formatSessionContextUsage(SessionContextUsage(0, 0)))
        assertEquals("999 / 0", formatSessionContextUsage(SessionContextUsage(999, 0)))
        assertEquals("1K / 0", formatSessionContextUsage(SessionContextUsage(1000, 0)))
        assertEquals("1K / 0", formatSessionContextUsage(SessionContextUsage(1999, 0)))
        assertEquals("12K / 0", formatSessionContextUsage(SessionContextUsage(12345, 0)))
    }

    @Test
    fun sizeGreaterThanZeroAppendsOverflowSafePercentWithoutClamping() {
        assertEquals("12 / 100 · 12%", formatSessionContextUsage(SessionContextUsage(12, 100)))
        assertEquals("1 / 3 · 33%", formatSessionContextUsage(SessionContextUsage(1, 3)))
        assertEquals("5 / 2 · 250%", formatSessionContextUsage(SessionContextUsage(5, 2)))
        assertEquals("1K / 1K · 150%", formatSessionContextUsage(SessionContextUsage(1500, 1000)))
        assertEquals(
            "9007199254740K / 1 · 900719925474099100%",
            formatSessionContextUsage(SessionContextUsage(9_007_199_254_740_991L, 1)),
        )
    }

    @Test
    fun compactCountFormatsCategoryTokens() {
        assertEquals("0", formatCompactCount(0))
        assertEquals("12", formatCompactCount(12))
        assertEquals("5K", formatCompactCount(5000))
        assertEquals("1K", formatCompactCount(1999))
    }
}
