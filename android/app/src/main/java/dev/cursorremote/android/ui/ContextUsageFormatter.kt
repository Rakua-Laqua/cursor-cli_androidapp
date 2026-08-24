package dev.cursorremote.android.ui

import dev.cursorremote.android.data.protocol.SessionContextUsage
import java.math.BigInteger

fun formatSessionContextUsage(usage: SessionContextUsage): String {
    val usedText = formatCompactCount(usage.used)
    val sizeText = formatCompactCount(usage.size)
    if (usage.size == 0L) {
        return "$usedText / $sizeText"
    }
    val percent =
        BigInteger.valueOf(usage.used)
            .multiply(BigInteger.valueOf(100))
            .divide(BigInteger.valueOf(usage.size))
    return "$usedText / $sizeText · $percent%"
}

internal fun formatCompactCount(value: Long): String =
    if (value < 1000L) value.toString() else "${value / 1000L}K"
