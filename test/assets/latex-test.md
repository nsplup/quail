# LaTeX 渲染测试文档

本文档用于测试 Markdown 渲染器对 LaTeX 公式的支持，包括行内公式与独立公式块。

## 1. 行内公式测试

质能方程：$E=mc^2$。

希腊字母：$\alpha, \beta, \gamma, \Delta, \Omega$。

上下标：$a_i^2$、$x_{i,j}^{n+1}$。

分数与根号：$\frac{1}{2}$、$\sqrt{x}$、$\sqrt[3]{y}$。

求和与积分：$\sum_{i=1}^{n} i$、$\int_0^1 x^2\,dx$。

极限：$\lim_{x\to 0}\frac{\sin x}{x}=1$。

向量与范数：$\mathbf{v}$、$\|\mathbf{x}\|_2$。

集合与数集：$x\in\mathbb{R}$、$A\subseteq B$。

括号自适应：$\left(\frac{a}{b}\right)$、$\left[\frac{1}{2}\right]$。

概率公式：$P(A\mid B)=\frac{P(B\mid A)P(A)}{P(B)}$。

## 2. 独立公式块测试

### 2.1 微积分基本定理

$$
\frac{d}{dx}\left(\int_a^x f(t)\,dt\right)=f(x)
$$

### 2.2 多行对齐公式

$$
\begin{aligned}
(a+b)^2 &= a^2+2ab+b^2\\
(a-b)^2 &= a^2-2ab+b^2
\end{aligned}
$$

### 2.3 矩阵

$$
A=
\begin{bmatrix}
1 & 2 & 3\\
4 & 5 & 6
\end{bmatrix},
\qquad
B=
\begin{pmatrix}
a & b\\
c & d
\end{pmatrix}
$$

### 2.4 分段函数

$$
f(x)=
\begin{cases}
x^2, & x\ge 0\\
-x, & x<0
\end{cases}
$$

### 2.5 求和与积分

$$
\sum_{k=1}^{n} k=\frac{n(n+1)}{2},
\qquad
\int_{-\infty}^{\infty} e^{-x^2}\,dx=\sqrt{\pi}
$$

### 2.6 极限

$$
\lim_{n\to\infty}\left(1+\frac{1}{n}\right)^n=e
$$

### 2.7 概率公式

$$
P(A\mid B)=\frac{P(B\mid A)P(A)}{P(B)}
$$

### 2.8 范数公式

$$
\|\mathbf{x}\|_2=
\sqrt{x_1^2+x_2^2+\cdots+x_n^2}
$$

### 2.9 带中文文本的公式

$$
\text{总成本}=\text{固定成本}+\text{单位成本}\times \text{数量}
$$

## 3. 行内与独立公式混合测试

当 $a>0$ 时，函数 $f(x)=ax^2+bx+c$ 的判别式为：

$$
\Delta=b^2-4ac
$$

若 $\Delta>0$，则方程 $f(x)=0$ 有两个不相等的实数根。

## 4. 测试完成

如果以上行内公式和独立公式块均能正确渲染，则说明 LaTeX 公式支持基本正常。