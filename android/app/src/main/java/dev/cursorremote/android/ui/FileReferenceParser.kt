package dev.cursorremote.android.ui

data class FileReference(
    val path: String,
    val startLine: Int?,
    val endLine: Int?,
    val startIndex: Int,
    val endIndex: Int,
)

private val CANDIDATE =
    Regex("""(?<![A-Za-z0-9._-])((?:[A-Za-z0-9._-]+/)+[A-Za-z0-9._-]+)(?::(\d{1,10})(?:-(\d{1,10}))?)?(?![A-Za-z0-9_/-])""")

private val TRAILING_PUNCTUATION = charArrayOf('.', ',', ';', ':', '!', '?', ')', ']', '}', '"', '\'', '`', '。', '、', '」', '』', '）')

fun parseFileReferences(text: String): List<FileReference> {
    if (text.isEmpty()) {
        return emptyList()
    }
    val refs = ArrayList<FileReference>()
    for (match in CANDIDATE.findAll(text)) {
        var path = match.groupValues[1]
        val startLineRaw = match.groupValues.getOrNull(2)?.ifEmpty { null }
        val endLineRaw = match.groupValues.getOrNull(3)?.ifEmpty { null }
        var endIndex = match.range.last + 1
        if (startLineRaw == null) {
            val stripped = stripTrailingPunctuation(path)
            endIndex -= path.length - stripped.length
            path = stripped
        }
        if (!isLinkablePath(text, match.range.first, path)) {
            continue
        }
        if (hasMalformedLineSuffix(text, match.range.first + path.length)) {
            continue
        }
        val startLine = startLineRaw?.let(::parsePositiveLine)
        if (startLineRaw != null && startLine == null) {
            continue
        }
        val endLine = endLineRaw?.let(::parsePositiveLine)
        if (endLineRaw != null && endLine == null) {
            continue
        }
        if (startLine != null && endLine != null && endLine < startLine) {
            continue
        }
        refs +=
            FileReference(
                path = path,
                startLine = startLine,
                endLine = endLine,
                startIndex = match.range.first,
                endIndex = endIndex,
            )
    }
    return refs
}

private fun isLinkablePath(
    text: String,
    startIndex: Int,
    path: String,
): Boolean {
    if (path.isEmpty() || '/' !in path) {
        return false
    }
    val segments = path.split('/')
    if (segments.any { it.isEmpty() || it == ".." }) {
        return false
    }
    if (startIndex > 0) {
        val previous = text[startIndex - 1]
        if (previous == '/' || previous == '\\') {
            return false
        }
    }
    if (startIndex >= 3 && text.substring(startIndex - 3, startIndex) == "://") {
        return false
    }
    if (':' in path || '\\' in path) {
        return false
    }
    return true
}

private val LINE_SUFFIX_BODY = Regex("""^\d{1,10}(-\d{1,10})?$""")

private fun hasMalformedLineSuffix(
    text: String,
    pathEndIndex: Int,
): Boolean {
    if (pathEndIndex >= text.length || text[pathEndIndex] != ':') {
        return false
    }
    var index = pathEndIndex + 1
    if (index >= text.length || text[index] !in '0'..'9') {
        return true
    }
    val bodyStart = index
    while (index < text.length && (text[index] in '0'..'9' || text[index] == '-')) {
        index += 1
    }
    if (index < text.length && isLineSuffixTokenChar(text[index])) {
        return true
    }
    return !LINE_SUFFIX_BODY.matches(text.substring(bodyStart, index))
}

private fun isLineSuffixTokenChar(char: Char): Boolean =
    char in 'A'..'Z' || char in 'a'..'z' || char in '0'..'9' || char == '_' || char == '/' || char == '-'

private fun parsePositiveLine(raw: String): Int? {
    if (raw.isEmpty() || raw.length > 10) {
        return null
    }
    val value = raw.toIntOrNull() ?: return null
    return if (value >= 1) value else null
}

private fun stripTrailingPunctuation(path: String): String {
    var end = path.length
    while (end > 0 && path[end - 1] in TRAILING_PUNCTUATION) {
        end -= 1
    }
    return path.substring(0, end)
}
