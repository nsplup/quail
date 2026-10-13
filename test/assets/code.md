# Markdown 代码高亮测试文档

> 用于测试 Markdown 渲染器 / 编辑器对常见编程语言代码块的语法高亮效果。  
> 不同平台支持的语言标识可能略有差异，未识别的语言通常会退化为普通代码块。

## Python

```python
from dataclasses import dataclass

@dataclass
class User:
    name: str
    age: int

def greet(user: User) -> str:
    return f"Hello, {user.name}!"

print(greet(User("World", 18)))
```

## JavaScript

```javascript
const greet = (name) => `Hello, ${name}!`;

const users = ["Alice", "Bob"];
users.forEach((name) => console.log(greet(name)));
```

## TypeScript

```typescript
interface User {
  id: number;
  name: string;
}

const greet = (user: User): string => `Hello, ${user.name}!`;

console.log(greet({ id: 1, name: "World" }));
```

## Java

```java
public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}
```

## C

```c
#include <stdio.h>

int main(void) {
    printf("Hello, World!\n");
    return 0;
}
```

## C++

```cpp
#include <iostream>
#include <string>

int main() {
    std::string name = "World";
    std::cout << "Hello, " << name << "!" << std::endl;
    return 0;
}
```

## C#

```csharp
using System;

class Program
{
    static void Main()
    {
        Console.WriteLine("Hello, World!");
    }
}
```

## Go

```go
package main

import "fmt"

func main() {
    name := "World"
    fmt.Printf("Hello, %s!\n", name)
}
```

## Rust

```rust
fn main() {
    let name = "World";
    println!("Hello, {}!", name);
}
```

## PHP

```php
<?php

declare(strict_types=1);

function greet(string $name): string {
    return "Hello, {$name}!";
}

echo greet("World") . PHP_EOL;
```

## Ruby

```ruby
def greet(name)
  "Hello, #{name}!"
end

puts greet("World")
```

## Swift

```swift
import Foundation

func greet(_ name: String) -> String {
    return "Hello, \(name)!"
}

print(greet("World"))
```

## Kotlin

```kotlin
fun greet(name: String): String = "Hello, $name!"

fun main() {
    println(greet("World"))
}
```

## Dart

```dart
String greet(String name) => 'Hello, $name!';

void main() {
  print(greet('World'));
}
```

## Scala

```scala
object Main extends App {
  def greet(name: String): String = s"Hello, $name!"
  println(greet("World"))
}
```

## R

```r
greet <- function(name) {
  paste0("Hello, ", name, "!")
}

print(greet("World"))
```

## MATLAB

```matlab
function msg = greet(name)
    msg = sprintf('Hello, %s!', name);
end

disp(greet('World'))
```

## Bash

```bash
#!/usr/bin/env bash
set -euo pipefail

name="World"
echo "Hello, ${name}!"
```

## PowerShell

```powershell
$name = "World"
Write-Host "Hello, $name!"
```

## SQL

```sql
SELECT id, name, created_at
FROM users
WHERE active = TRUE
ORDER BY created_at DESC
LIMIT 10;
```

## HTML

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hello</title>
</head>
<body>
  <h1>Hello, World!</h1>
</body>
</html>
```

## CSS

```css
:root {
  --primary-color: #3498db;
}

body {
  margin: 0;
  color: var(--primary-color);
  font-family: system-ui, sans-serif;
}
```

## SCSS

```scss
$primary-color: #3498db;

.button {
  color: $primary-color;

  &:hover {
    color: darken($primary-color, 10%);
  }
}
```

## JSON

```json
{
  "name": "markdown-highlight-test",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "node server.js"
  }
}
```

## YAML

```yaml
name: markdown-highlight-test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run tests
        run: npm test
```

## XML

```xml
<?xml version="1.0" encoding="UTF-8"?>
<note>
  <to>World</to>
  <from>Markdown</from>
  <message>Hello, World!</message>
</note>
```

## Markdown

```markdown
# 标题

**加粗文本** 和 *斜体文本*

- 列表项 1
- 列表项 2

[链接](https://example.com)
```

## Dockerfile

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
```

## Makefile

```makefile
CC = gcc
CFLAGS = -Wall -O2
TARGET = hello

all: $(TARGET)

$(TARGET): hello.c
	$(CC) $(CFLAGS) -o $(TARGET) hello.c

clean:
	rm -f $(TARGET)
```

## Lua

```lua
local function greet(name)
  return "Hello, " .. name .. "!"
end

print(greet("World"))
```

## Perl

```perl
use strict;
use warnings;

my $name = "World";
print "Hello, $name!\n";
```

## Haskell

```haskell
greet :: String -> String
greet name = "Hello, " ++ name ++ "!"

main :: IO ()
main = putStrLn (greet "World")
```

## Elixir

```elixir
defmodule Hello do
  def greet(name), do: "Hello, #{name}!"
end

IO.puts(Hello.greet("World"))
```

## Erlang

```erlang
-module(hello).
-export([main/0]).

main() ->
    io:format("Hello, World!~n").
```

## Clojure

```clojure
(defn greet [name]
  (str "Hello, " name "!"))

(println (greet "World"))
```

## F#

```fsharp
let greet name = sprintf "Hello, %s!" name

[<EntryPoint>]
let main _ =
    printfn "%s" (greet "World")
    0
```

## Visual Basic .NET

```vbnet
Module Program
    Sub Main()
        Console.WriteLine("Hello, World!")
    End Sub
End Module
```

## Objective-C

```objectivec
#import <Foundation/Foundation.h>

int main(void) {
    @autoreleasepool {
        NSLog(@"Hello, World!");
    }
    return 0;
}
```

## Assembly

```asm
section .data
    msg db 'Hello, World!', 0xA
    len equ $ - msg

section .text
    global _start

_start:
    mov rax, 1
    mov rdi, 1
    mov rsi, msg
    mov rdx, len
    syscall

    mov rax, 60
    xor rdi, rdi
    syscall
```

## Verilog

```verilog
module hello;
  initial begin
    $display("Hello, World!");
  end
endmodule
```

## VHDL

```vhdl
entity hello is
end entity;

architecture sim of hello is
begin
  process
  begin
    report "Hello, World!" severity note;
    wait;
  end process;
end architecture;
```

## Julia

```julia
function greet(name)
    return "Hello, $name!"
end

println(greet("World"))
```

## Groovy

```groovy
def greet(name) {
    "Hello, ${name}!"
}

println greet("World")
```

## Solidity

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Hello {
    function greet() public pure returns (string memory) {
        return "Hello, World!";
    }
}
```

## GraphQL

```graphql
query GetUser($id: ID!) {
  user(id: $id) {
    id
    name
    email
  }
}
```

## TOML

```toml
[package]
name = "markdown-highlight-test"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
```

## INI

```ini
[server]
host = 127.0.0.1
port = 8080
debug = true
```

## Diff

```diff
- old line
+ new line
  unchanged line
```

## 正则表达式

```regex
^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$
```