"""
斐波那契数列工具模块

提供斐波那契数列的常用操作：
- fib(n)：返回第 n 个斐波那契数（0-indexed）
- fib_sequence(n)：返回前 n 个斐波那契数的列表
- is_fib(num)：判断一个数是否是斐波那契数
"""

import math


def fib(n: int) -> int:
    """
    返回第 n 个斐波那契数（0-indexed）。

    定义：fib(0) = 0, fib(1) = 1, fib(n) = fib(n-1) + fib(n-2)

    参数:
        n: 非负整数索引

    返回:
        第 n 个斐波那契数

    异常:
        ValueError: 当 n 为负数时抛出
    """
    if n < 0:
        raise ValueError(f"n 必须是非负整数，实际为 {n}")

    if n == 0:
        return 0
    if n == 1:
        return 1

    # 迭代方式计算，避免递归栈溢出，时间复杂度 O(n)，空间复杂度 O(1)
    prev, curr = 0, 1
    for _ in range(2, n + 1):
        prev, curr = curr, prev + curr
    return curr


def fib_sequence(n: int) -> list[int]:
    """
    返回前 n 个斐波那契数的列表。

    例如 fib_sequence(5) 返回 [0, 1, 1, 2, 3]

    参数:
        n: 要生成的斐波那契数个数（非负整数）

    返回:
        包含前 n 个斐波那契数的列表

    异常:
        ValueError: 当 n 为负数时抛出
    """
    if n < 0:
        raise ValueError(f"n 必须是非负整数，实际为 {n}")

    if n == 0:
        return []

    if n == 1:
        return [0]

    sequence = [0, 1]
    for _ in range(2, n):
        sequence.append(sequence[-1] + sequence[-2])
    return sequence


def is_fib(num: int) -> bool:
    """
    判断一个数是否是斐波那契数。

    利用斐波那契数的数学性质：一个数 x 是斐波那契数当且仅当
    5*x² + 4 或 5*x² - 4 中至少有一个是完全平方数。

    参数:
        num: 待判断的非负整数

    返回:
        True 如果 num 是斐波那契数，否则 False
    """
    if num < 0:
        return False

    def _is_perfect_square(x: int) -> bool:
        """判断一个数是否是完全平方数。"""
        root = math.isqrt(x)
        return root * root == x

    check = 5 * num * num
    return _is_perfect_square(check + 4) or _is_perfect_square(check - 4)


if __name__ == "__main__":
    # 测试 fib(n)
    print("=== 测试 fib(n) ===")
    assert fib(0) == 0, f"fib(0) 期望 0，实际 {fib(0)}"
    assert fib(1) == 1, f"fib(1) 期望 1，实际 {fib(1)}"
    assert fib(2) == 1, f"fib(2) 期望 1，实际 {fib(2)}"
    assert fib(5) == 5, f"fib(5) 期望 5，实际 {fib(5)}"
    assert fib(10) == 55, f"fib(10) 期望 55，实际 {fib(10)}"
    assert fib(20) == 6765, f"fib(20) 期望 6765，实际 {fib(20)}"
    print(f"  fib(0)  = {fib(0)}")
    print(f"  fib(1)  = {fib(1)}")
    print(f"  fib(2)  = {fib(2)}")
    print(f"  fib(5)  = {fib(5)}")
    print(f"  fib(10) = {fib(10)}")
    print(f"  fib(20) = {fib(20)}")
    print("  fib(n) 测试全部通过 ✓")

    # 测试 fib_sequence(n)
    print("\n=== 测试 fib_sequence(n) ===")
    assert fib_sequence(0) == [], f"fib_sequence(0) 期望 []，实际 {fib_sequence(0)}"
    assert fib_sequence(1) == [0], f"fib_sequence(1) 期望 [0]，实际 {fib_sequence(1)}"
    assert fib_sequence(2) == [0, 1], f"fib_sequence(2) 期望 [0, 1]，实际 {fib_sequence(2)}"
    assert fib_sequence(7) == [0, 1, 1, 2, 3, 5, 8], (
        f"fib_sequence(7) 期望 [0,1,1,2,3,5,8]，实际 {fib_sequence(7)}"
    )
    print(f"  fib_sequence(0) = {fib_sequence(0)}")
    print(f"  fib_sequence(1) = {fib_sequence(1)}")
    print(f"  fib_sequence(5) = {fib_sequence(5)}")
    print(f"  fib_sequence(10) = {fib_sequence(10)}")
    print("  fib_sequence(n) 测试全部通过 ✓")

    # 测试 is_fib(num)
    print("\n=== 测试 is_fib(num) ===")
    # 已知斐波那契数：0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144
    fib_numbers = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144]
    for val in fib_numbers:
        assert is_fib(val), f"is_fib({val}) 应为 True"
    # 已知非斐波那契数
    non_fib_numbers = [4, 6, 7, 9, 10, 11, 12, 14, 15, 16, 50, 100]
    for val in non_fib_numbers:
        assert not is_fib(val), f"is_fib({val}) 应为 False"
    # 边界情况
    assert not is_fib(-1), "is_fib(-1) 应为 False"
    print(f"  is_fib(0)   = {is_fib(0)}")
    print(f"  is_fib(8)   = {is_fib(8)}")
    print(f"  is_fib(144) = {is_fib(144)}")
    print(f"  is_fib(100) = {is_fib(100)}")
    print(f"  is_fib(-1)  = {is_fib(-1)}")
    print("  is_fib(num) 测试全部通过 ✓")

    # 测试异常
    print("\n=== 测试异常处理 ===")
    try:
        fib(-1)
        assert False, "fib(-1) 应该抛出 ValueError"
    except ValueError as e:
        print(f"  fib(-1) 正确抛出 ValueError: {e}")

    try:
        fib_sequence(-5)
        assert False, "fib_sequence(-5) 应该抛出 ValueError"
    except ValueError as e:
        print(f"  fib_sequence(-5) 正确抛出 ValueError: {e}")
    print("  异常处理测试全部通过 ✓")

    print("\n🎉 所有测试全部通过！")
