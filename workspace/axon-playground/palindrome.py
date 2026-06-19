"""
回文检测工具模块

提供三个核心功能：
- is_palindrome: 判断字符串是否为回文
- longest_palindrome: 找出字符串中最长的回文子串
- count_palindromes: 统计单词列表中回文单词的数量
"""

import re
from typing import List


def _clean(s: str) -> str:
    """预处理字符串：转小写、移除所有非字母数字字符（空格、标点等）。"""
    return re.sub(r'[^a-z0-9]', '', s.lower())


def is_palindrome(s: str) -> bool:
    """
    判断字符串是否是回文。

    比较时忽略大小写、空格和标点符号，仅基于字母和数字字符判断。
    空字符串和单字符视为回文。

    示例:
        >>> is_palindrome("A man, a plan, a canal: Panama")
        True
        >>> is_palindrome("race a car")
        False
    """
    cleaned = _clean(s)
    return cleaned == cleaned[::-1]


def longest_palindrome(s: str) -> str:
    """
    找出给定字符串中最长的回文子串。

    比较时忽略大小写、空格和标点符号，但返回结果取自原字符串的对应位置。
    如果存在多个等长回文子串，返回最先出现的那一个。
    空字符串返回空字符串。

    算法：中心扩展法，时间复杂度 O(n^2)，空间复杂度 O(1)。

    示例:
        >>> longest_palindrome("babad")
        'bab'
        >>> longest_palindrome("cbbd")
        'bb'
    """
    if not s:
        return ""

    cleaned = _clean(s)
    if not cleaned:
        return ""

    # 建立 cleaned 字符到原字符串索引的映射
    mapping: List[int] = []
    for i, ch in enumerate(s):
        if ch.isalnum():
            mapping.append(i)

    n = len(cleaned)
    best_start = 0
    best_len = 0

    def expand(left: int, right: int) -> None:
        """以 left/right 为中心向两边扩展，更新最佳回文区间。"""
        nonlocal best_start, best_len
        while left >= 0 and right < n and cleaned[left] == cleaned[right]:
            cur_len = right - left + 1
            if cur_len > best_len:
                best_len = cur_len
                best_start = left
            left -= 1
            right += 1

    for center in range(n):
        # 奇数长度回文
        expand(center, center)
        # 偶数长度回文
        expand(center, center + 1)

    # 根据 cleaned 中的最佳回文区间，映射回原字符串
    start_idx = mapping[best_start]
    end_idx = mapping[best_start + best_len - 1]
    return s[start_idx:end_idx + 1]


def count_palindromes(words: List[str]) -> int:
    """
    给定单词列表，统计其中回文单词的数量。

    判断时忽略大小写、空格和标点符号。
    空字符串或仅含非字母数字字符的字符串不计为回文。

    示例:
        >>> count_palindromes(["radar", "hello", "level", "world"])
        2
        >>> count_palindromes(["A man a plan a canal Panama", "not", "RaceCar"])
        2
    """
    count = 0
    for w in words:
        cleaned = _clean(w)
        if cleaned and cleaned == cleaned[::-1]:
            count += 1
    return count


if __name__ == "__main__":
    # ---------- 测试 is_palindrome ----------
    assert is_palindrome("racecar") is True
    assert is_palindrome("RaceCar") is True           # 忽略大小写
    assert is_palindrome("hello") is False
    assert is_palindrome("") is True                  # 空字符串视为回文
    assert is_palindrome("a") is True                 # 单字符
    assert is_palindrome("A man, a plan, a canal: Panama") is True  # 忽略空格和标点
    assert is_palindrome("race a car") is False
    print("✓ is_palindrome 全部测试通过")

    # ---------- 测试 longest_palindrome ----------
    assert longest_palindrome("babad") in ("bab", "aba")  # "bab" 先出现
    assert longest_palindrome("cbbd") == "bb"
    assert longest_palindrome("a") == "a"
    assert longest_palindrome("") == ""
    assert longest_palindrome("racecar") == "racecar"
    print("✓ longest_palindrome 全部测试通过")

    # ---------- 测试 count_palindromes ----------
    assert count_palindromes(["radar", "hello", "level", "world"]) == 2
    assert count_palindromes(["RaceCar", "Madam", "not"]) == 2   # 忽略大小写
    assert count_palindromes([]) == 0
    assert count_palindromes(["", "!", "@#%"]) == 0              # 空或纯标点不计
    assert count_palindromes(["A man, a plan, a canal: Panama", "No 'x' in Nixon"]) == 2
    print("✓ count_palindromes 全部测试通过")

    print("\n所有测试用例通过！")
