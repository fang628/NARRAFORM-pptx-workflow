// Each navigation state owns its measured shadow and stroke width.
export const progressEffectsRule='导航各状态独立还原：只允许竖向渐变，禁止发光glow；可保留实际细描边，阴影与描边互斥，有阴影时对应描边宽度为0。状态描边宽度用trackStrokeWidth、completedStrokeWidth、activeStrokeWidth记录，范围0至3；未单列时沿用strokeWidth。';
export {shadowStrokeEffects as progressShadowStroke} from './native-appearance-policy.mjs';
