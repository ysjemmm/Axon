"""
随机密码生成工具模块

使用 secrets 模块（密码学安全的随机数生成器）来生成高安全性随机密码。
提供密码生成、强度评估和批量生成功能。
"""

import secrets
import string


# ── 字符集常量 ──────────────────────────────────────────────
_UPPER = string.ascii_uppercase          # A-Z
_LOWER = string.ascii_lowercase          # a-z
_DIGITS = string.digits                  # 0-9
_SYMBOLS = "!@#$%^&*()_+-=[]{}|;:,.<>?"  # 常用可打印符号，排除易混淆字符


def generate_password(
    length: int = 16,
    use_upper: bool = True,
    use_lower: bool = True,
    use_digits: bool = True,
    use_symbols: bool = True,
) -> str:
    """
    生成一个指定长度和字符集的随机密码。

    参数:
        length:      密码长度，默认 16。必须 ≥ 1。
        use_upper:   是否包含大写字母 (A-Z)，默认 True。
        use_lower:   是否包含小写字母 (a-z)，默认 True。
        use_digits:  是否包含数字 (0-9)，默认 True。
        use_symbols: 是否包含特殊符号，默认 True。

    返回:
        str: 生成的随机密码。

    异常:
        ValueError: 没有任何字符集被启用，或 length < 1。
    """
    if length < 1:
        raise ValueError("密码长度必须 ≥ 1")

    # 根据参数拼接可用字符池
    pool = ""
    required_chars: list[str] = []  # 保证每种启用的字符集至少出现一次

    if use_upper:
        pool += _UPPER
        required_chars.append(secrets.choice(_UPPER))
    if use_lower:
        pool += _LOWER
        required_chars.append(secrets.choice(_LOWER))
    if use_digits:
        pool += _DIGITS
        required_chars.append(secrets.choice(_DIGITS))
    if use_symbols:
        pool += _SYMBOLS
        required_chars.append(secrets.choice(_SYMBOLS))

    if not pool:
        raise ValueError("至少需要启用一种字符集 (upper / lower / digits / symbols)")

    # 如果密码长度不足以容纳每类至少一个字符，则降级为纯随机（不保证每类出现）
    if length < len(required_chars):
        required_chars = []

    # 剩余长度用完整字符池随机填充
    remaining = length - len(required_chars)
    rest = [secrets.choice(pool) for _ in range(remaining)]

    # 合并并随机打乱，避免固定位置暴露字符类别
    all_chars = required_chars + rest
    # 使用 secrets.randbelow 实现 Fisher-Yates 洗牌，保证密码学安全
    shuffled = list(all_chars)
    for i in range(len(shuffled) - 1, 0, -1):
        j = secrets.randbelow(i + 1)
        shuffled[i], shuffled[j] = shuffled[j], shuffled[i]

    return "".join(shuffled)


def password_strength(password: str) -> str:
    """
    评估密码强度。

    评估维度：
      - 长度：≥8 加一分，≥14 再加一分
      - 字符多样性：包含大写/小写/数字/符号，每类加一分

    评分映射：
      - 0~2 分 → "weak"
      - 3~4 分 → "medium"
      - 5~6 分 → "strong"

    参数:
        password: 待评估的密码字符串。

    返回:
        str: "weak" / "medium" / "strong"
    """
    score = 0

    # 长度维度
    if len(password) >= 8:
        score += 1
    if len(password) >= 14:
        score += 1

    # 字符多样性维度
    if any(c.isupper() for c in password):
        score += 1
    if any(c.islower() for c in password):
        score += 1
    if any(c.isdigit() for c in password):
        score += 1
    if any(c in _SYMBOLS for c in password):
        score += 1

    if score <= 2:
        return "weak"
    elif score <= 4:
        return "medium"
    else:
        return "strong"


def generate_multiple(
    count: int = 5,
    length: int = 16,
    use_upper: bool = True,
    use_lower: bool = True,
    use_digits: bool = True,
    use_symbols: bool = True,
) -> list[str]:
    """
    批量生成多个随机密码。

    参数:
        count:       需要生成的密码数量，默认 5。
        length:      每个密码的长度，默认 16。
        其余参数同 generate_password()。

    返回:
        list[str]: 生成的密码列表。
    """
    if count < 1:
        raise ValueError("生成数量必须 ≥ 1")
    return [
        generate_password(
            length=length,
            use_upper=use_upper,
            use_lower=use_lower,
            use_digits=use_digits,
            use_symbols=use_symbols,
        )
        for _ in range(count)
    ]


# ── 简单测试用例 ──────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 60)
    print("  随机密码生成工具 — 测试")
    print("=" * 60)

    # 1. 生成单个默认密码
    print("\n[1] 默认参数生成一个密码 (length=16, 全字符集):")
    pwd1 = generate_password()
    strength1 = password_strength(pwd1)
    print(f"    密码: {pwd1}")
    print(f"    强度: {strength1}")

    # 2. 自定义长度
    print("\n[2] 生成 24 位密码 (全字符集):")
    pwd2 = generate_password(length=24)
    print(f"    密码: {pwd2}")
    print(f"    强度: {password_strength(pwd2)}")

    # 3. 仅字母+数字（无符号）
    print("\n[3] 仅字母+数字，12 位:")
    pwd3 = generate_password(length=12, use_symbols=False)
    print(f"    密码: {pwd3}")
    print(f"    强度: {password_strength(pwd3)}")

    # 4. 纯数字密码
    print("\n[4] 纯数字密码，6 位:")
    pwd4 = generate_password(length=6, use_upper=False, use_lower=False,
                             use_symbols=False)
    print(f"    密码: {pwd4}")
    print(f"    强度: {password_strength(pwd4)}")

    # 5. 批量生成
    print("\n[5] 批量生成 8 个密码 (length=16):")
    passwords = generate_multiple(count=8)
    for i, p in enumerate(passwords, 1):
        print(f"    [{i}] {p}  →  {password_strength(p)}")

    # 6. 强度评估边界测试
    print("\n[6] 强度评估边界测试:")
    test_cases = [
        "abc",                # 短 + 仅小写 → weak
        "abcdefgh",           # ≥8 + 仅小写 → 2 → weak
        "Abcdefgh",           # ≥8 + 大小写 → 3 → medium
        "Abcdef1!",           # ≥8 + 大写/小写/数字/符号 → 5 → strong
        "aB3!xY9@kL2#mN4$p", # ≥14 + 全类别 → 6 → strong
    ]
    for tc in test_cases:
        print(f"    '{tc}'  →  {password_strength(tc)}")

    # 7. 异常处理
    print("\n[7] 异常参数测试:")
    try:
        generate_password(length=0)
    except ValueError as e:
        print(f"    长度=0: 捕获 ValueError → {e}")

    try:
        generate_password(use_upper=False, use_lower=False,
                          use_digits=False, use_symbols=False)
    except ValueError as e:
        print(f"    无字符集: 捕获 ValueError → {e}")

    print("\n" + "=" * 60)
    print("  测试完成")
    print("=" * 60)
