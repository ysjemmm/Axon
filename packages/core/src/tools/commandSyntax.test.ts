import { describe, expect, it } from "vitest";
import { findUnterminatedCommand } from "./commandSyntax.js";

const ps = (c: string) => findUnterminatedCommand(c, "powershell");
const sh = (c: string) => findUnterminatedCommand(c, "posix");

describe("findUnterminatedCommand · PowerShell", () => {
  it("写完的命令不误判", () => {
    for (const c of [
      `Get-ChildItem -Recurse | Where-Object { $_.Length -gt 1kb }`,
      `Write-Host "it's ok"`,
      `Write-Host 'he said "hi"'`,
      `Write-Host 'don''t'`,
      `Write-Host "a ""quoted"" word"`,
      "Write-Host \"tick `\" inside\"",
      `$a = @(1, 2, 3); $a[0]`,
      `git commit -m "fix: (scope) [x]"`,
      `$s = @"\nline ( { [\n"@\nWrite-Host $s`,
      `# 注释里的 " 不算\nGet-Date`,
      `<# 块注释 ' #> Get-Date`,
      `npm test`,
    ]) expect(ps(c), c).toBeNull();
  });

  it("没写完的命令能认出来", () => {
    expect(ps(`Write-Host "hello`)).toContain("双引号");
    expect(ps(`Write-Host 'hello`)).toContain("单引号");
    expect(ps(`$s = @"\nabc\n`)).toContain("here-string");
    expect(ps(`if ($a) { Write-Host 1`)).toContain("{");
    expect(ps(`Get-ChildItem |`)).toContain("|");
    expect(ps("Get-ChildItem `")).toContain("反引号");
    expect(ps(`npm run build &&`)).toContain("&&");
    expect(ps(`<# 没闭合`)).toContain("<#");
  });
});

describe("findUnterminatedCommand · bash", () => {
  it("写完的命令不误判", () => {
    for (const c of [
      `echo "it's ok"`,
      `grep -r 'a"b' src | wc -l`,
      `cat <<EOF > a.txt\nhello "\nEOF`,
      `cat <<-'END'\n\tx\n\tEND`,
      `echo \\"`,
      `case $x in a) echo 1;; esac`,
      `ls # 注释里的 ' 不算`,
      "echo `date`",
    ]) expect(sh(c), c).toBeNull();
  });

  it("没写完的命令能认出来", () => {
    expect(sh(`echo "hello`)).toContain("双引号");
    expect(sh(`echo 'hello`)).toContain("单引号");
    expect(sh(`cat <<EOF\nhello`)).toContain("heredoc");
    expect(sh(`ls \\`)).toContain("反斜杠");
    expect(sh(`ls |`)).toContain("|");
  });
});
