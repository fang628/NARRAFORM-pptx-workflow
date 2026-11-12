// Navigation has one exterior effect per state. Prefer a visible glow when an
// old record or model supplies both; a zero-strength glow never hides a shadow.
export const progressEffectsRule='导航各状态独立检测与还原：只允许竖向渐变，禁止横向或斜向渐变。发光与描边各自独立，可单独存在也可组合；阴影与发光、描边均互斥，有阴影时该状态描边宽度为0。不要因检测到发光而补描边，也不要因检测到描边而补发光。状态描边宽度用trackStrokeWidth、completedStrokeWidth、activeStrokeWidth分别记录，范围0至3；未单列时沿用strokeWidth。';
export {exclusiveNativeEffects as exclusiveProgressEffects} from './native-appearance-policy.mjs';
