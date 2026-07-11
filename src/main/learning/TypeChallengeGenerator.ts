/**
 * TypeChallengeGenerator — TypeScript 类型挑战题生成器
 *
 * 为每个 TypeScript 高级类型知识点生成交互式挑战题。
 * 用户完成代码后，由 TypeScriptCompilerService 编译验证。
 *
 * 挑战格式：
 * - 描述（prompt）：说明要完成的代码
 * - 起始代码（starterCode）：含 `/*__TYPE_YOUR_CODE_HERE__*\/` 占位符
 * - 验证代码（verifierCode）：编译时附加的类型测试
 * - 提示（hint）：解题思路提示
 * - 解决方案（solution）：参考答案
 *
 * 适配现有学习系统：
 * - 知识点 ID 与 TYPESCRIPT_LEARNING_ITEMS 对齐
 * - 难度级别保持一致
 * - 验证通过后更新 LearningVocabularyManager 的掌握度
 */

import { log } from '../logger/Logger'
import type { ConceptDifficulty } from './types'

// ── 挑战类型定义 ──

export const CHALLENGE_PLACEHOLDER = '/*__TYPE_YOUR_CODE_HERE__*/'

export interface TypeChallengeTemplate {
  /** 关联的知识点 ID（与 TYPESCRIPT_LEARNING_ITEMS 对齐） */
  conceptId: string
  /** 知识点名称 */
  conceptName: string
  /** 难度 */
  difficulty: ConceptDifficulty
  /** 挑战描述（给用户看的说明） */
  prompt: string
  /** 起始代码（含占位符） */
  starterCode: string
  /** 验证代码（编译时附加在 userCode 之后，充当类型测试） */
  verifierCode: string
  /** 解题提示 */
  hint: string
  /** 参考解决方案代码 */
  solution: string
  /** 简短标签 */
  label: string
  /** 解题后的知识点解释 */
  explanation: string
}

export interface GeneratedChallenge {
  /** 挑战唯一 ID */
  id: string
  /** 关联概念 */
  conceptId: string
  conceptName: string
  difficulty: ConceptDifficulty
  /** 生成的提示文本 */
  prompt: string
  /** 用户可见的起始代码 */
  starterCode: string
  /** 提示 */
  hint: string
  /** 标签 */
  label: string
  /** 内部使用的验证代码（不暴露给用户） */
  verifierCode: string
  /** 内部使用的解决方案 */
  solution: string
  explanation: string
}

export interface ChallengeResult {
  /** 是否通过验证 */
  passed: boolean
  /** 编译器诊断文本（出错时） */
  diagnosticText: string
  /** 编译器诊断原始列表 */
  diagnostics: Array<{ code: string; message: string; line: number }>
  /** 提示文本（错误时给出） */
  hint: string
  /** 知识点解释 */
  explanation: string
}

// ── 预定义挑战模板 ──

const CHALLENGE_TEMPLATES: TypeChallengeTemplate[] = [
  // ═══════════════════════════════════════════════
  // 1. 泛型函数
  // ═══════════════════════════════════════════════
  {
    conceptId: 'generic functions',
    conceptName: 'Generic Functions',
    difficulty: 'easy',
    label: '泛型函数',
    prompt: `实现一个泛型函数 \`firstElement\`，它接受一个数组 \`arr\`，返回数组的第一个元素。

要求：
- 函数必须保留元素类型（传入 string[] 返回 string）
- 不要使用 any`,
    starterCode: `function firstElement<T>(arr: T[]): /*__TYPE_YOUR_CODE_HERE__*/ {
  return arr[0];
}`,
    verifierCode: `// 类型测试
const s = firstElement(['a', 'b', 'c']);
// 期望 s 的类型为 string
const _sCheck: string = s;

const n = firstElement([1, 2, 3]);
// 期望 n 的类型为 number
const _nCheck: number = n;

// 空数组测试
const empty = firstElement([] as string[]);
const _emptyCheck: string | undefined = empty;`,
    hint: '思考一下：当数组为空时 \`arr[0]\` 返回什么类型？TypeScript 泛型 + 索引访问的返回值是什么？',
    solution: 'function firstElement<T>(arr: T[]): T | undefined {\n  return arr[0];\n}',
    explanation: '泛型函数 \`firstElement<T>\` 接受类型参数 T。由于数组可能为空，\`arr[0]\` 的实际返回类型是 \`T | undefined\`（TypeScript 在 strict 模式下会这么推断）。当然也可以写 \`T\` 如果允许 undefined 的隐式返回，但更精确的做法是返回 \`T | undefined\`。',
  },

  // ═══════════════════════════════════════════════
  // 2. 泛型约束
  // ═══════════════════════════════════════════════
  {
    conceptId: 'generic constraints',
    conceptName: 'Generic Constraints',
    difficulty: 'medium',
    label: '泛型约束',
    prompt: `实现一个泛型约束：\`longest\` 函数接受两个参数，它们必须具有 \`length: number\` 属性。

要求：
- 使用 extends 约束类型参数
- 返回值类型为较长的那一个`,
    starterCode: `interface HasLength {
  length: number;
}

function longest<T extends HasLength>(a: T, b: T): /*__TYPE_YOUR_CODE_HERE__*/ {
  return a.length >= b.length ? a : b;
}`,
    verifierCode: `// 类型测试
const longerStr = longest('hello', 'world!');
// 期望类型为 string
const _sCheck: string = longerStr;

const longerArr = longest([1, 2], [1, 2, 3]);
// 期望类型为 number[]
const _aCheck: number[] = longerArr;

// 正向验证：确保字符串和数组正确工作即可`,
    hint: '约束已经写好了：\`T extends HasLength\`。返回值类型应该是什么？如果 a 和 b 都是 T 类型，返回的也是其中之一，那么返回值类型就是...',
    solution: 'function longest<T extends HasLength>(a: T, b: T): T {\n  return a.length >= b.length ? a : b;\n}',
    explanation: '泛型约束 \`T extends HasLength\` 确保 T 具有 length 属性。函数体返回 a 或 b（都是 T 类型），所以返回值类型是 T。这就是泛型约束的典型用法：限制了类型参数的范围，但保留了具体类型信息。',
  },

  // ═══════════════════════════════════════════════
  // 3. 条件类型
  // ═══════════════════════════════════════════════
  {
    conceptId: 'conditional types',
    conceptName: 'Conditional Types',
    difficulty: 'hard',
    label: '条件类型',
    prompt: `实现一个条件类型 \`IsString<T>\`，当 T 是 string 类型时返回 true 的字面量类型，否则返回 false。

要求：
- 使用条件类型语法 \`T extends U ? A : B\`
- 结果必须是字面量类型 \`true\` 或 \`false\``,
    starterCode: `type IsString<T> = /*__TYPE_YOUR_CODE_HERE__*/;

// 使用示例
type A = IsString<'hello'>;
type B = IsString<42>;`,
    verifierCode: `// 类型测试
type Test1 = IsString<'hello'>;
// 结果应为 true
const _t1: true = null as unknown as Test1;

type Test2 = IsString<42>;
// 结果应为 false
const _t2: false = null as unknown as Test2;

type Test3 = IsString<string>;
// 结果应为 true
const _t3: true = null as unknown as Test3;

type Test4 = IsString<boolean>;
// 结果应为 false
const _t4: false = null as unknown as Test4;`,
    hint: '条件类型的语法是 \`T extends U ? TrueType : FalseType\`。检查 T 是否可以赋值给 string：\`T extends string ? ... : ...\`',
    solution: 'type IsString<T> = T extends string ? true : false;',
    explanation: '条件类型 \`IsString<T>\` 检查 T 是否 extends string。如果是，结果为 true（字面量类型），否则为 false。这是 TypeScript 类型层面的 if/else。注意此处利用了分布式条件类型的特性：当 T 是联合类型时，条件会分发到每个成员。',
  },

  // ═══════════════════════════════════════════════
  // 4. Infer 关键字
  // ═══════════════════════════════════════════════
  {
    conceptId: 'infer keyword',
    conceptName: 'Infer Keyword',
    difficulty: 'hard',
    label: 'infer 关键字',
    prompt: `实现一个类型 \`UnpackPromise<T>\`，从 Promise<T> 中提取内部的类型 T。

要求：
- 使用 infer 关键字在条件类型中进行模式匹配
- 如果 T 不是 Promise，返回 T 本身`,
    starterCode: `type UnpackPromise<T> = /*__TYPE_YOUR_CODE_HERE__*/;

// 使用示例
type A = UnpackPromise<Promise<string>>;
type B = UnpackPromise<number>;`,
    verifierCode: `// 类型测试
type Test1 = UnpackPromise<Promise<string>>;
// 应为 string
const _t1: string = null as unknown as Test1;

type Test2 = UnpackPromise<Promise<number[]>>;
// 应为 number[]
const _t2: number[] = null as unknown as Test2;

type Test3 = UnpackPromise<number>;
// 应为 number（非 Promise 原样返回）
const _t3: number = null as unknown as Test3;

type Test4 = UnpackPromise<Promise<Promise<string>>>;
// 只展开一层，所以是 Promise<string>
const _t4: Promise<string> = null as unknown as Test4;`,
    hint: '在条件类型的 true 分支中使用 \`infer\` 声明一个待推断的类型变量：\`T extends Promise<infer U> ? U : T\`',
    solution: 'type UnpackPromise<T> = T extends Promise<infer U> ? U : T;',
    explanation: '\`infer U\` 在条件类型中声明了一个待推断的类型变量。当 T 匹配 \`Promise<infer U>\` 模式时，U 会被自动推断为 Promise 内部的类型。这是 TypeScript 内置 \`Awaited<T>\` 和 \`ReturnType<T>\` 的实现基础。',
  },

  // ═══════════════════════════════════════════════
  // 5. 映射类型
  // ═══════════════════════════════════════════════
  {
    conceptId: 'mapped types',
    conceptName: 'Mapped Types',
    difficulty: 'hard',
    label: '映射类型',
    prompt: `实现一个映射类型 \`Readonly<T>\`，将 T 的所有属性变为 readonly。

要求：
- 使用 \`in keyof\` 语法遍历属性
- 对每个属性添加 \`readonly\` 修饰符
- 保持值的类型不变`,
    starterCode: `type MyReadonly<T> = /*__TYPE_YOUR_CODE_HERE__*/;

// 使用示例
interface User {
  name: string;
  age: number;
}

type ReadonlyUser = MyReadonly<User>;`,
    verifierCode: `// 类型测试
interface User {
  name: string;
  age: number;
}

type ReadonlyUser = MyReadonly<User>;

// 检查属性是否存在
const _nameCheck: string = null as unknown as ReadonlyUser['name'];
const _ageCheck: number = null as unknown as ReadonlyUser['age'];

// 检查键名称正确
type ReadonlyKeys = keyof ReadonlyUser;
const _keysCheck: 'name' | 'age' = null as unknown as ReadonlyKeys;`,
    hint: '映射类型的语法：\`{ [P in keyof T]: T[P] }\`。在 \`[\` 前面加 \`readonly\` 关键字可以让每个属性变为只读。',
    solution: 'type MyReadonly<T> = { readonly [P in keyof T]: T[P]; };',
    explanation: '映射类型 \`MyReadonly<T>\` 遍历 T 的所有键（\`P in keyof T\`），对每个属性 \`P\`，值的类型保持 \`T[P]\` 不变，但添加了 \`readonly\` 修饰符。结果类型与原类型有相同的键，但所有属性都是只读的。这正是 TypeScript 内置 \`Readonly<T>\` 的实现方式。',
  },

  // ═══════════════════════════════════════════════
  // 6. Pick 工具类型
  // ═══════════════════════════════════════════════
  {
    conceptId: 'pick t k',
    conceptName: 'Pick<T, K>',
    difficulty: 'medium',
    label: 'Pick<T, K>',
    prompt: `实现工具类型 \`MyPick<T, K>\`，从类型 T 中选取一组属性 K 构造新类型。

要求：
- K 必须是 T 的键的子集（使用 extends 约束）
- 结果类型只包含 K 中指定的属性`,
    starterCode: `type MyPick<T, K extends keyof T> = /*__TYPE_YOUR_CODE_HERE__*/;

// 使用示例
interface Todo {
  title: string;
  description: string;
  completed: boolean;
}

type TodoPreview = MyPick<Todo, 'title' | 'completed'>;`,
    verifierCode: `// 类型测试
interface Todo {
  title: string;
  description: string;
  completed: boolean;
}

type TodoPreview = MyPick<Todo, 'title' | 'completed'>;

// 只应有 title 和 completed
const _t1: string = null as unknown as TodoPreview['title'];
const _t2: boolean = null as unknown as TodoPreview['completed'];

// 不应有 description（类型级断言，避免 @ts-expect-error）
type _AssertNoDesc = 'description' extends keyof TodoPreview ? never : true;
const _checkNoDesc: true = null as unknown as _AssertNoDesc;`,
    hint: '使用映射类型 \`{ [P in K]: T[P] }\`。K 已经被约束为 \`keyof T\` 的子集，所以可以直接用 \`P in K\` 遍历。',
    solution: 'type MyPick<T, K extends keyof T> = { [P in K]: T[P]; };',
    explanation: '\`MyPick<T, K extends keyof T>\` 使用泛型约束确保 K 是 T 的键的子集，然后通过映射类型遍历 K 中的每个键，选取对应的属性值类型。这是 TypeScript 内置工具类型中 Pick 的实现方式。',
  },

  // ═══════════════════════════════════════════════
  // 7. Omit 工具类型
  // ═══════════════════════════════════════════════
  {
    conceptId: 'omit t k',
    conceptName: 'Omit<T, K>',
    difficulty: 'medium',
    label: 'Omit<T, K>',
    prompt: `实现工具类型 \`MyOmit<T, K>\`，从类型 T 中排除一组属性 K。

要求：
- 使用条件类型 + 映射类型的组合
- 排除掉 K 中指定的属性
- 剩余的属性保持原样`,
    starterCode: `type MyOmit<T, K extends keyof T> = /*__TYPE_YOUR_CODE_HERE__*/;

// 使用示例
interface Todo {
  title: string;
  description: string;
  completed: boolean;
}

type TodoWithoutDesc = MyOmit<Todo, 'description'>;`,
    verifierCode: `// 类型测试
interface Todo {
  title: string;
  description: string;
  completed: boolean;
}

type TodoWithoutDesc = MyOmit<Todo, 'description'>;

// 应有 title 和 completed
const _t1: string = null as unknown as TodoWithoutDesc['title'];
const _t2: boolean = null as unknown as TodoWithoutDesc['completed'];

// 不应有 description（类型级断言）
type _AssertNoDesc = 'description' extends keyof TodoWithoutDesc ? never : true;
const _checkNoDesc: true = null as unknown as _AssertNoDesc;`,
    hint: '结合映射类型和条件类型：\`{ [P in keyof T as P extends K ? never : P]: T[P] }\`。使用 \`as\` 子句重映射键，当 P 在 K 中时映射为 never（被排除）。',
    solution: 'type MyOmit<T, K extends keyof T> = { [P in keyof T as P extends K ? never : P]: T[P]; };',
    explanation: '\`MyOmit\` 使用了 TypeScript 4.1+ 的键重映射（key remapping）语法。\`as\` 子句对每个键 P 应用条件类型：如果 P 在 K 中，映射到 never（被排除），否则保持原键。这比 Pick + Exclude 的组合更直接。',
  },

  // ═══════════════════════════════════════════════
  // 8. 分布式条件类型
  // ═══════════════════════════════════════════════
  {
    conceptId: 'distributive conditional types',
    conceptName: 'Distributive Conditional Types',
    difficulty: 'hard',
    label: '分布式条件类型',
    prompt: `实现 \`ToArray<T>\` 类型，将联合类型的每个成员转为数组（分布式）。

要求：
- 输入 string | number 应输出 string[] | number[]
- \`ToArrayNonDist<T>\` 版本应阻止分发，输出 (string | number)[]`,
    starterCode: `// 分布式版本（T 是裸类型参数时自动分发）
type ToArray<T> = /*__TYPE_YOUR_CODE_HERE__*/;

// 非分布式版本（阻止分发）
type ToArrayNonDist<T> = /*__TYPE_YOUR_CODE_HERE__*/;`,
    verifierCode: `// 类型测试：分布式版本
type Arr1 = ToArray<string | number>;
// 应为 string[] | number[]
const _t1: string[] | number[] = null as unknown as Arr1;

// 类型测试：非分布式版本
type Arr2 = ToArrayNonDist<string | number>;
// 应为 (string | number)[]
const _t2: (string | number)[] = null as unknown as Arr2;

// 单一类型测试
type Arr3 = ToArray<string>;
// 应为 string[]
const _t3: string[] = null as unknown as Arr3;`,
    hint: '分布式版本：\`T extends unknown ? T[] : never\`。非分布式版本：用方括号包裹裸类型参数 \`[T] extends [unknown] ? T[] : never\` 来阻止分发。',
    solution: 'type ToArray<T> = T extends unknown ? T[] : never;\ntype ToArrayNonDist<T> = [T] extends [unknown] ? T[] : never;',
    explanation: '当条件类型的检查类型是一个裸类型参数（如 \`T extends ...\`）且实际传入的是联合类型时，TypeScript 会将联合类型的每个成员分别代入条件计算，这就是分布式条件类型。用方括号 \`[T]\` 包裹可以阻止分发行为，将联合类型作为一个整体处理。',
  },

  // ═══════════════════════════════════════════════
  // 9. 模板字面量类型
  // ═══════════════════════════════════════════════
  {
    conceptId: 'template literal types',
    conceptName: 'Template Literal Types',
    difficulty: 'medium',
    label: '模板字面量类型',
    prompt: `实现 \`EventName<T>\` 类型，生成以 "on" 开头的事件名。

要求：
- 使用模板字面量类型拼接 "on" + Capitalize<T>
- T 必须是 string 的子类型`,
    starterCode: `type EventName<T extends string> = /*__TYPE_YOUR_CODE_HERE__*/;

// 使用示例
type ClickEvent = EventName<'click'>;
type FocusEvent = EventName<'focus'>;`,
    verifierCode: `// 类型测试
type ClickEvent = EventName<'click'>;
// 应为 "onClick"
const _t1: 'onClick' = null as unknown as ClickEvent;

type FocusEvent = EventName<'focus'>;
// 应为 "onFocus"
const _t2: 'onFocus' = null as unknown as FocusEvent;

type MouseEvent = EventName<'mouseEnter'>;
// 应为 "onMouseEnter"
const _t3: 'onMouseEnter' = null as unknown as MouseEvent;`,
    hint: '模板字面量类型的语法：\`\`on$\{Capitalize<T>\}\`\`。\`Capitalize\` 是 TypeScript 内置的字符串操作类型，将首字母大写。',
    solution: 'type EventName<T extends string> = `on${Capitalize<T>}`;',
    explanation: '模板字面量类型使用 JavaScript 模板字符串语法在类型层面拼接字符串。\`Capitalize<T>\` 是 TypeScript 内置的字符串操作类型，将字符串字面量的首字母大写。配合映射类型的键重映射，可以构建类型安全的事件处理系统。',
  },

  // ═══════════════════════════════════════════════
  // 10. 递归类型
  // ═══════════════════════════════════════════════
  {
    conceptId: 'recursive type',
    conceptName: 'Recursive Types',
    difficulty: 'hard',
    label: '递归类型',
    prompt: `实现一个递归类型 \`DeepPartial<T>\`，将 T 的所有属性（包括嵌套属性）变为可选。

要求：
- 如果 T 是对象类型，遍历其所有属性并递归设为可选
- 如果 T 是基本类型（string、number 等），保持不变
- 使用条件类型区分对象和基本类型`,
    starterCode: `type DeepPartial<T> = /*__TYPE_YOUR_CODE_HERE__*/;

// 使用示例
interface DeepTodo {
  title: string;
  metadata: {
    createdAt: Date;
    tags: string[];
  };
}

type PartialDeepTodo = DeepPartial<DeepTodo>;`,
    verifierCode: `// 类型测试
interface DeepTodo {
  title: string;
  metadata: {
    createdAt: Date;
    tags: string[];
  };
}

type PartialDeepTodo = DeepPartial<DeepTodo>;

// 顶层属性可选
const _t1: { title?: string; metadata?: { createdAt?: Date; tags?: string[] } } =
  null as unknown as PartialDeepTodo;

// 可以直接赋值空对象（全部可选）
const empty: PartialDeepTodo = {};

// 基本类型不应被转换
type StrResult = DeepPartial<string>;
const _t2: string = null as unknown as StrResult;

// 数组应被处理为内部元素可选
type ArrResult = DeepPartial<string[]>;
const _t3: string[] = null as unknown as ArrResult;`,
    hint: '结合条件类型和映射类型：\`T extends object ? { [P in keyof T]?: DeepPartial<T[P]> } : T\`。注意 \`object\` 包含数组和函数，需要额外处理。',
    solution: 'type DeepPartial<T> = T extends Record<string, unknown>\n  ? { [P in keyof T]?: DeepPartial<T[P]> }\n  : T;',
    explanation: '\`DeepPartial\` 是一个递归类型，在自身的定义中引用了自己。当 T 是对象类型时（用 \`Record<string, unknown>\` 判断），遍历所有属性并设为可选，同时递归调用 \`DeepPartial\` 处理属性的值类型。基本类型则直接返回不做处理。这种模式在处理深层嵌套的配置对象时非常有用。',
  },

  // ═══════════════════════════════════════════════
  // 11. 类型守卫
  // ═══════════════════════════════════════════════
  {
    conceptId: 'type guards',
    conceptName: 'Type Guards',
    difficulty: 'medium',
    label: '类型守卫',
    prompt: `实现一个用户自定义类型守卫 \`isNumber\`，检查值是否为 number 类型。

要求：
- 使用 \`value is number\` 类型谓词
- 函数返回布尔值`,
    starterCode: `function isNumber(value: unknown): /*__TYPE_YOUR_CODE_HERE__*/ {
  return typeof value === 'number';
}`,
    verifierCode: `// 类型测试
const test1 = isNumber(42);
// 应为 boolean
const _t1: boolean = test1;

const test2 = isNumber('hello');
// 应为 boolean
const _t2: boolean = test2;

// 在条件分支中的类型收窄
function process(value: string | number): string {
  if (isNumber(value)) {
    // 此处 value 应为 number
    const _n: number = value;
    return value.toFixed(2);
  } else {
    // 此处 value 应为 string
    const _s: string = value;
    return value.toUpperCase();
  }
}`,
    hint: '类型谓词语法：\`value is TypeName\`。当函数返回 true 时，TypeScript 将参数的类型收窄为 TypeName。',
    solution: 'function isNumber(value: unknown): value is number {\n  return typeof value === \'number\';\n}',
    explanation: '用户自定义类型守卫使用类型谓词 \`value is TypeName\` 语法。当函数返回 true 时，TypeScript 会在当前作用域中将参数的类型收窄为 TypeName。这是 \`typeof\`、\`instanceof\` 等内置守卫之外，扩展类型收窄能力的重要方式。',
  },

  // ═══════════════════════════════════════════════
  // 12. 断言函数
  // ═══════════════════════════════════════════════
  {
    conceptId: 'assertion functions',
    conceptName: 'Assertion Functions',
    difficulty: 'hard',
    label: '断言函数',
    prompt: `实现断言函数 \`assertDefined<T>\`，断言值不为 null 或 undefined。

要求：
- 使用 \`asserts value is T\` 语法
- 如果值为 null 或 undefined，抛出错误
- 函数自身不返回值`,
    starterCode: `function assertDefined<T>(value: T): /*__TYPE_YOUR_CODE_HERE__*/ {
  if (value === null || value === undefined) {
    throw new Error('Value must not be null or undefined');
  }
}`,
    verifierCode: `// 类型测试
function process(str: string | null): number {
  assertDefined(str);
  // 此处 str 应被收窄为 string
  const _s: string = str;
  return str.length;
}

// 断言后类型已被收窄
const value: string | undefined = 'hello';
assertDefined(value);
const _v: string = value;

// 带泛型的断言
const num: number | null = 42;
assertDefined(num);
const _n: number = num;`,
    hint: '断言函数的类型谓词语法：\`asserts value is T\`。注意断言函数\不\返回布尔值，而是在检查失败时抛出异常。如果函数正常返回，TypeScript 就认为类型已收窄。',
    solution: 'function assertDefined<T>(value: T): asserts value is NonNullable<T> {\n  if (value === null || value === undefined) {\n    throw new Error(\'Value must not be null or undefined\');\n  }\n}',
    explanation: '断言函数使用 \`asserts\` 关键字声明类型收窄效果。与类型守卫不同，断言函数不返回布尔值——如果函数执行完毕没有抛出异常，TypeScript 就认为条件满足。这让断言函数非常适合前置条件检查（如参数校验）。',
  },

  // ═══════════════════════════════════════════════
  // 13. 映射类型修饰符
  // ═══════════════════════════════════════════════
  {
    conceptId: 'property modifiers',
    conceptName: 'Property Modifiers',
    difficulty: 'medium',
    label: '映射类型修饰符',
    prompt: `实现 \`Concrete<T>\` 类型，移除 T 中所有属性的可选标记和 readonly 修饰符。

要求：
- 使用 -? 移除可选标记
- 使用 -readonly 移除 readonly
- 保持值的类型不变`,
    starterCode: `type Concrete<T> = /*__TYPE_YOUR_CODE_HERE__*/;

// 使用示例
interface MaybeUser {
  readonly name?: string;
  readonly age?: number;
}

type ConcreteUser = Concrete<MaybeUser>;
// 结果: { name: string; age: number }`,
    verifierCode: `// 类型测试
interface MaybeUser {
  readonly name?: string;
  readonly age?: number;
}

type ConcreteUser = Concrete<MaybeUser>;

// 所有属性不应为 undefined
const _t1: ConcreteUser = { name: 'Alice', age: 25 };

// 不应有 readonly（可以修改）
const u: ConcreteUser = { name: 'Alice', age: 25 };
u.name = 'Bob';

// 检查属性是否存在
const _name: string = u.name;
const _age: number = u.age;`,
    hint: '在映射类型中使用 \`-readonly\` 移除 readonly，使用 \`-?\` 移除可选标记：\`{ -readonly [P in keyof T]-?: T[P] }\`',
    solution: 'type Concrete<T> = { -readonly [P in keyof T]-?: T[P]; };',
    explanation: '映射类型支持在遍历属性时使用 +/- 符号添加或移除修饰符。\`-readonly\` 移除只读（+\`readonly\` 添加只读），\`-?\` 移除可选标记（\`+?\` 或 \`?\` 添加可选）。这在需要对类型进行严格化处理时非常有用。',
  },

  // ═══════════════════════════════════════════════
  // 14. Exclude 工具类型
  // ═══════════════════════════════════════════════
  {
    conceptId: 'exclude t u',
    conceptName: 'Exclude<T, U>',
    difficulty: 'medium',
    label: 'Exclude<T, U>',
    prompt: `实现工具类型 \`MyExclude<T, U>\`，从联合类型 T 中排除可以赋值给 U 的成员。

要求：
- 利用分布式条件类型的特性
- 当 T 的成员可以赋值给 U 时排除，否则保留`,
    starterCode: `type MyExclude<T, U> = /*__TYPE_YOUR_CODE_HERE__*/;

// 使用示例
type Result = MyExclude<'a' | 'b' | 'c', 'a' | 'c'>;
// 期望: 'b'`,
    verifierCode: `// 类型测试
type Test1 = MyExclude<'a' | 'b' | 'c', 'a' | 'c'>;
// 应为 'b'
const _t1: 'b' = null as unknown as Test1;

type Test2 = MyExclude<string | number | boolean, string | number>;
// 应为 boolean
const _t2: boolean = null as unknown as Test2;

// 当 T 是单一类型时
type Test3 = MyExclude<string, number>;
// 应为 string
const _t3: string = null as unknown as Test3;

// 排除所有
type Test4 = MyExclude<'a' | 'b', 'a' | 'b'>;
// 应为 never
const _t4: never = null as unknown as Test4;`,
    hint: '利用分布式条件类型：当 T 是裸类型参数时，条件类型会分发到联合的每个成员。\`T extends U ? never : T\` 对每个成员判断——如果 T 在 U 中就排除（never），否则保留。',
    solution: 'type MyExclude<T, U> = T extends U ? never : T;',
    explanation: '\`MyExclude\` 利用分布式条件类型的特性实现。当 T 是一个联合类型时，条件类型会分发到每个成员：\`MyExclude<\'a\' | \'b\', \'a\'>\` 相当于 \`(\'a\' extends \'a\' ? never : \'a\') | (\'b\' extends \'a\' ? never : \'b\') = never | \'b\' = \'b\'\`。这是 TypeScript 内置 Exclude 的实现方式。',
  },

  // ═══════════════════════════════════════════════
  // 15. ReturnType
  // ═══════════════════════════════════════════════
  {
    conceptId: 'returntype t',
    conceptName: 'ReturnType<T>',
    difficulty: 'hard',
    label: 'ReturnType<T>',
    prompt: `实现工具类型 \`MyReturnType<T>\`，提取函数类型的返回值类型。

要求：
- 使用 infer 在条件类型中进行模式匹配
- 如果 T 不是函数类型，返回 never`,
    starterCode: `type MyReturnType<T> = /*__TYPE_YOUR_CODE_HERE__*/;

// 使用示例
type Fn = (x: string) => number;
type R = MyReturnType<Fn>;
// 期望: number`,
    verifierCode: `// 类型测试
type Fn1 = (x: string) => number;
type R1 = MyReturnType<Fn1>;
// 应为 number
const _t1: number = null as unknown as R1;

type Fn2 = () => { a: string; b: number };
type R2 = MyReturnType<Fn2>;
// 应为 { a: string; b: number }
const _t2: { a: string; b: number } = null as unknown as R2;

// 非函数类型
type R3 = MyReturnType<string>;
// 应为 never
const _t3: never = null as unknown as R3;

// 泛型函数
type Fn3 = <T>(arg: T) => Promise<T>;
type R4 = MyReturnType<Fn3>;
// 应为 Promise<unknown>（在类型层面无法保留泛型参数）
const _t4: Promise<unknown> = null as unknown as R4;`,
    hint: '使用条件类型匹配函数签名模式：\`T extends (...args: any[]) => infer R ? R : never\`。\`infer R\` 会推断出返回值类型。',
    solution: 'type MyReturnType<T> = T extends (...args: any[]) => infer R ? R : never;',
    explanation: '\`MyReturnType\` 使用 infer 在条件类型中匹配函数签名模式。\`T extends (...args: any[]) => infer R ? R : never\`：如果 T 匹配函数签名，\`infer R\` 推断出返回值类型；否则返回 never。这是 TypeScript 内置 ReturnType 的精确实现。',
  },

  // ═══════════════════════════════════════════════
  // 16. 联合类型 + 可辨识联合
  // ═══════════════════════════════════════════════
  {
    conceptId: 'union types',
    conceptName: 'Union Types',
    difficulty: 'easy',
    label: '可辨识联合',
    prompt: `完善可辨识联合（Discriminated Union）类型定义。

要求：
- 为 \`Circle\` 和 \`Rectangle\` 类型添加 \`kind\` 字段区分
- 实现 \`area\` 函数，使用 switch 根据 \`kind\` 收窄类型并计算面积`,
    starterCode: `// 完善以下类型定义
type Circle = /*__TYPE_YOUR_CODE_HERE__*/;
type Rectangle = /*__TYPE_YOUR_CODE_HERE__*/;

type Shape = Circle | Rectangle;

function area(shape: Shape): number {
  switch (shape.kind) {
    case 'circle':
      // 此处 shape 应为 Circle
      return Math.PI * shape.radius ** 2;
    case 'rectangle':
      // 此处 shape 应为 Rectangle
      return shape.width * shape.height;
  }
}`,
    verifierCode: `// 类型测试
const circle: Circle = { kind: 'circle', radius: 5 };
const rect: Rectangle = { kind: 'rectangle', width: 3, height: 4 };

// 计算面积
const _a1: number = area(circle);
const _a2: number = area(rect);

// 类型收窄测试
function process(shape: Shape): string {
  if (shape.kind === 'circle') {
    // Circle 应有 radius
    const _r: number = shape.radius;
    return 'circle';
  } else {
    // Rectangle 应有 width 和 height
    const _w: number = shape.width;
    return 'rectangle';
  }
}

// 仅保留正向测试（验证正确用法）`,
    hint: '使用字面量类型的 \`kind\` 字段：\`Circle = { kind: "circle"; radius: number }\`，\`Rectangle = { kind: "rectangle"; width: number; height: number }\`。字面量类型让 TypeScript 可以根据 kind 的值精确收窄类型。',
    solution: 'type Circle = { kind: \'circle\'; radius: number };\ntype Rectangle = { kind: \'rectangle\'; width: number; height: number };',
    explanation: '可辨识联合（Discriminated Union）模式使用一个字面量类型的公共字段（称为 tag/discriminant）来区分联合的各个成员。TypeScript 可以通过 switch 或 if 检查该字段的值，自动将联合类型收窄到具体的成员类型。这种模式在 Redux reducer、状态机等领域非常常见。',
  },

  // ═══════════════════════════════════════════════
  // 17. 条件类型 + 函数重载
  // ═══════════════════════════════════════════════
  {
    conceptId: 'conditional types',
    conceptName: 'Conditional Types',
    difficulty: 'hard',
    label: '条件类型 + 函数重载',
    prompt: `实现 \`FilterPropertyTypes<T, U>\`，从对象类型 T 中筛选出值类型匹配 U 的属性。

要求：
- 使用映射类型 + 键重映射 + 条件类型组合
- 只保留值类型为 U 的属性`,
    starterCode: `type FilterPropertyTypes<T, U> = /*__TYPE_YOUR_CODE_HERE__*/;

// 使用示例
interface Document {
  title: string;
  pages: number;
  content: string;
  published: boolean;
}

type StringProps = FilterPropertyTypes<Document, string>;
// 期望: { title: string; content: string }`,
    verifierCode: `// 类型测试
interface Document {
  title: string;
  pages: number;
  content: string;
  published: boolean;
}

type StringProps = FilterPropertyTypes<Document, string>;
// 只应有 title 和 content
const _t1: string = null as unknown as StringProps['title'];
const _t2: string = null as unknown as StringProps['content'];
// 不应有 pages 和 published（类型级断言）
type _NoPages = 'pages' extends keyof StringProps ? never : true;
const _check3: true = null as unknown as _NoPages;
type _NoPublished = 'published' extends keyof StringProps ? never : true;
const _check4: true = null as unknown as _NoPublished;

type NumberProps = FilterPropertyTypes<Document, number>;
// 只应有 pages
const _t5: number = null as unknown as NumberProps['pages'];

// 空结果测试
type Empty = FilterPropertyTypes<Document, Date>;
// 应为 {}
const _t6: {} = null as unknown as Empty;`,
    hint: '使用键重映射：\`{ [P in keyof T as T[P] extends U ? P : never]: T[P] }\`。当属性的值类型 T[P] 匹配 U 时保留该键，否则映射为 never（被排除）。',
    solution: 'type FilterPropertyTypes<T, U> = { [P in keyof T as T[P] extends U ? P : never]: T[P]; };',
    explanation: '这个类型结合了三种高级类型技术：映射类型（\`P in keyof T\`）、键重映射（\`as\` 子句）、和条件类型（\`T[P] extends U ? P : never\`）。只有当属性的值类型匹配 U 时，键才会被保留。这是按值类型过滤属性的通用模式。',
  },
]

// ── TypeChallengeGenerator ──

export class TypeChallengeGenerator {
  private challengeCounter = 0

  /**
   * 根据概念名称生成挑战题。
   *
   * @param conceptName - 知识点名称（如 "Conditional Types"、"Generic Functions"）
   * @returns 生成的挑战，或 null（如果找不到匹配的挑战模板）
   */
  generateChallenge(conceptName?: string): GeneratedChallenge | null {
    const template = conceptName
      ? this.findTemplate(conceptName)
      : this.getRandomTemplate()

    if (!template) return null

    this.challengeCounter++
    const id = `ch_${this.challengeCounter}_${Date.now().toString(36)}`

    return {
      id,
      conceptId: template.conceptId,
      conceptName: template.conceptName,
      difficulty: template.difficulty,
      prompt: template.prompt,
      starterCode: template.starterCode,
      hint: template.hint,
      label: template.label,
      verifierCode: template.verifierCode,
      solution: template.solution,
      explanation: template.explanation,
    }
  }

  /**
   * 根据概念 ID 获取挑战（确保同一概念每次生成一致的内容）。
   */
  generateChallengeByConceptId(conceptId: string): GeneratedChallenge | null {
    const template = CHALLENGE_TEMPLATES.find(
      (t) => t.conceptId === conceptId.toLowerCase(),
    )
    if (!template) return null

    this.challengeCounter++
    const id = `ch_${this.challengeCounter}_${Date.now().toString(36)}`

    return {
      id,
      conceptId: template.conceptId,
      conceptName: template.conceptName,
      difficulty: template.difficulty,
      prompt: template.prompt,
      starterCode: template.starterCode,
      hint: template.hint,
      label: template.label,
      verifierCode: template.verifierCode,
      solution: template.solution,
      explanation: template.explanation,
    }
  }

  /**
   * 获取所有可用挑战对应的概念名称列表。
   */
  getAvailableChallenges(): Array<{
    conceptId: string
    conceptName: string
    difficulty: ConceptDifficulty
    label: string
  }> {
    return CHALLENGE_TEMPLATES.map((t) => ({
      conceptId: t.conceptId,
      conceptName: t.conceptName,
      difficulty: t.difficulty,
      label: t.label,
    }))
  }

  /**
   * 将用户完成的代码与验证代码合并，构建完整的编译代码。
   *
   * 支持两种模式：
   * 1. 填空模式：如果 starterCode 包含占位符，将占位符替换为用户代码
   * 2. 完整代码模式：用户直接提交完整的 TypeScript 代码
   */
  buildFullCode(starterCode: string, userCode: string, verifierCode: string): string {
    // 如果占位符在 starterCode 中且用户只提交了替换内容（不是完整代码），
    // 将用户代码插入占位符位置
    const trimmedCode = userCode.trim()

    if (starterCode.includes(CHALLENGE_PLACEHOLDER)) {
      // 判断用户提交的是片段还是完整代码
      const isFragment = !trimmedCode.includes('\n') &&
        !trimmedCode.includes('function ') &&
        !trimmedCode.includes('type ') &&
        !trimmedCode.includes('interface ')

      if (isFragment) {
        // 填空模式：替换占位符
        const completedCode = starterCode.replace(CHALLENGE_PLACEHOLDER, trimmedCode)
        return `${completedCode}\n\n// ── Type verification ──\n${verifierCode}`
      }
    }

    // 完整代码模式：直接使用用户提交的代码
    return `${trimmedCode}\n\n// ── Type verification ──\n${verifierCode}`
  }

  /**
   * 从概念名称查找匹配的模板。
   */
  private findTemplate(conceptName: string): TypeChallengeTemplate | null {
    const lower = conceptName.toLowerCase()

    // 精确匹配 conceptId
    const exact = CHALLENGE_TEMPLATES.find((t) => t.conceptId === lower)
    if (exact) return exact

    // 模糊匹配 conceptName
    const byName = CHALLENGE_TEMPLATES.find(
      (t) => t.conceptName.toLowerCase() === lower,
    )
    if (byName) return byName

    // 关键词匹配
    return (
      CHALLENGE_TEMPLATES.find((t) => {
        const name = t.conceptName.toLowerCase()
        const id = t.conceptId
        return (
          lower.includes(name) ||
          name.includes(lower) ||
          lower.includes(id) ||
          id.includes(lower) ||
          t.label.includes(conceptName)
        )
      }) || null
    )
  }

  /**
   * 随机返回一个模板。
   */
  private getRandomTemplate(): TypeChallengeTemplate {
    const idx = Math.floor(Math.random() * CHALLENGE_TEMPLATES.length)
    return CHALLENGE_TEMPLATES[idx]
  }

  /**
   * 获取模板总数。
   */
  getTemplateCount(): number {
    return CHALLENGE_TEMPLATES.length
  }
}

/** 全局单例 */
export const typeChallengeGenerator = new TypeChallengeGenerator()
