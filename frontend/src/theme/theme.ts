/**
 * CION NMS — Direction A "Clarity" theme for Ant Design 6.
 *
 * Drop-in ConfigProvider theme. Wired to the EXISTING AppContext.resolvedTheme:
 *
 *   import { ConfigProvider } from 'antd';
 *   import { buildTheme } from './theme/theme';
 *   const { resolvedTheme } = useAppContext();
 *   <ConfigProvider theme={buildTheme(resolvedTheme)}> ... </ConfigProvider>
 *
 * Every hex here is lifted 1:1 from the approved HTML prototype.
 * `cssVar: true` emits CSS variables at runtime so the values are also
 * reachable from plain CSS / custom components (e.g. the mesh heatmap).
 */
import { theme, type ThemeConfig } from 'antd';

export type Mode = 'light' | 'dark';

const FONT_SANS =
  "'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
export const FONT_MONO = "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', monospace";

/** Raw palette — also re-exported for custom components that can't read tokens. */
export const palette = {
  light: {
    accent: '#2563eb', accentWeak: 'rgba(37,99,235,.10)',
    success: '#16a34a', successWeak: 'rgba(22,163,74,.12)',
    warning: '#d97706', warningWeak: 'rgba(217,119,6,.13)',
    danger: '#dc2626', dangerWeak: 'rgba(220,38,38,.10)',
    teal: '#0d9488', tealWeak: 'rgba(13,148,136,.12)',
    bg: '#f4f6fb', surface: '#ffffff', surface2: '#f7f9fc', surface3: '#eef2f8',
    border: '#e2e7f0', line: '#eef1f6',
    text: '#0e1726', textDim: '#586375', textFaint: '#8a94a6',
    shadow: '0 1px 2px rgba(16,24,40,.04), 0 12px 28px -10px rgba(16,24,40,.10)',
  },
  dark: {
    accent: '#3b82f6', accentWeak: 'rgba(59,130,246,.16)',
    success: '#22c55e', successWeak: 'rgba(34,197,94,.15)',
    warning: '#f59e0b', warningWeak: 'rgba(245,158,11,.15)',
    danger: '#f04545', dangerWeak: 'rgba(240,69,69,.16)',
    teal: '#2dd4bf', tealWeak: 'rgba(45,212,191,.15)',
    bg: '#0a111f', surface: '#101a2c', surface2: '#0d1626', surface3: '#172339',
    border: '#1d2a3f', line: '#172338',
    text: '#e9eef8', textDim: '#94a2ba', textFaint: '#60708a',
    shadow: '0 1px 2px rgba(0,0,0,.4), 0 16px 36px -12px rgba(0,0,0,.6)',
  },
} as const;

export function buildTheme(mode: Mode): ThemeConfig {
  const dark = mode === 'dark';
  const p = palette[mode];

  return {
    // antd 6 types cssVar as an object ({ prefix?, key? }), not a boolean.
    // Empty object enables it with the default `--ant-*` variable prefix, which
    // every `var(--ant-color-*)` reference in the app relies on.
    cssVar: {},
    hashed: true,
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,

    token: {
      colorPrimary: p.accent,
      colorSuccess: p.success,
      colorWarning: p.warning,
      colorError: p.danger,
      colorInfo: p.accent,

      colorBgLayout: p.bg,
      colorBgContainer: p.surface,
      colorBgElevated: p.surface,
      colorBorder: p.border,
      colorBorderSecondary: p.line,

      colorText: p.text,
      colorTextSecondary: p.textDim,
      colorTextTertiary: p.textFaint,

      fontFamily: FONT_SANS,
      fontSize: 14,

      // Direction A = generous, rounded
      borderRadius: 10,
      borderRadiusLG: 14,
      borderRadiusSM: 8,
      borderRadiusXS: 6,

      // Direction A = comfortable density (B would drop these + add compactAlgorithm)
      controlHeight: 38,
      controlHeightLG: 46,
      controlHeightSM: 30,

      wireframe: false,
      boxShadow: p.shadow,
      boxShadowSecondary: dark
        ? '0 8px 24px -8px rgba(0,0,0,.5)'
        : '0 6px 18px -8px rgba(16,24,40,.12)',
    },

    components: {
      Layout: {
        bodyBg: p.bg,
        headerBg: p.surface,
        headerHeight: 64,
        headerPadding: '0 30px',
        siderBg: p.surface, // A keeps the sidebar light/airy
      },
      Menu: {
        itemBg: 'transparent',
        subMenuItemBg: 'transparent',
        itemColor: p.textDim,
        itemHoverBg: dark ? 'rgba(148,162,186,.08)' : 'rgba(14,23,38,.04)',
        itemSelectedBg: p.accentWeak,
        itemSelectedColor: p.accent,
        itemBorderRadius: 10,
        itemHeight: 42,
        itemMarginInline: 0,
        iconSize: 18,
        groupTitleColor: p.textFaint,
        groupTitleFontSize: 11,
      },
      Table: {
        headerBg: p.surface2,
        headerColor: p.textFaint,
        headerSplitColor: 'transparent',
        borderColor: p.line,
        rowHoverBg: dark ? 'rgba(148,162,186,.06)' : p.surface2,
        cellPaddingBlock: 12,
        cellPaddingInline: 16,
        fontSize: 13,
      },
      Card: { borderRadiusLG: 14, paddingLG: 22, colorBorderSecondary: dark ? '#1a2740' : p.line },
      Button: {
        fontWeight: 600,
        controlHeight: 38,
        primaryShadow: `0 3px 10px -3px ${dark ? 'rgba(59,130,246,.5)' : 'rgba(37,99,235,.45)'}`,
        defaultBorderColor: p.border,
      },
      Input: { controlHeight: 38, colorBgContainer: p.surface2, activeShadow: `0 0 0 3px ${p.accentWeak}` },
      Select: { controlHeight: 38 },
      Tag: { borderRadiusSM: 999, defaultBg: p.surface3, defaultColor: p.textDim }, // A = pill tags
      Tabs: { inkBarColor: p.accent, itemSelectedColor: p.accent, titleFontSize: 14 },
      Segmented: { itemSelectedColor: p.accent },
      Modal: { borderRadiusLG: 16 },
    },
  };
}
