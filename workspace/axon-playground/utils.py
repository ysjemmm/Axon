"""字符串工具模块。

提供常用的字符串处理工具函数。
"""


def reverse_string(s: str) -> str:
    """反转字符串并返回。

    Args:
        s: 待反转的字符串。

    Returns:
        反转后的字符串。

    Examples:
        >>> reverse_string("hello")
        'olleh'
        >>> reverse_string("")
        ''
        >>> reverse_string("a")
        'a'
    """
    return s[::-1]


def count_chars(s: str) -> dict[str, int]:
    """统计字符串中每个字符出现的次数。

    Args:
        s: 待统计的字符串。

    Returns:
        一个字典，键为字符，值为该字符出现的次数。

    Examples:
        >>> count_chars("hello")
        {'h': 1, 'e': 1, 'l': 2, 'o': 1}
        >>> count_chars("")
        {}
        >>> count_chars("aaa")
        {'a': 3}
    """
    result: dict[str, int] = {}
    for ch in s:
        result[ch] = result.get(ch, 0) + 1
    return result


if __name__ == "__main__":
    sample = "hello world"
    print(f"原始字符串: {sample!r}")
    print(f"反转结果:  {reverse_string(sample)!r}")
    print(f"字符统计:  {count_chars(sample)}")
