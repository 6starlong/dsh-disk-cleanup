// 由 scripts/build.mjs 生成，不要手改。
window.__ModuleLoader__.load({
  id: "dsh-disk-cleanup",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    // ---- index.jsx ----
    /**
     * dsh-disk-cleanup 的浏览器半边：插件页上的「过期清理」配置卡片。
     *
     * 宿主按 schema 自动生成的表单只显示标了 volatile 的字段，而这里要的是一张
     * 有说明、有保存按钮的卡片，所以宿主侧关掉自动表单（见 lib/index.js 的
     * settings.configure），由本文件在 plugins.bundle.config 槽里渲染。
     *
     * 这张卡片只碰两个 volatile 字段，其余字段仍走 cordis.patch.yml：
     *  - autoCleanup：是否自动清理；
     *  - cleanupMaxAgeDays：保留天数。
     *
     * @module dsh-disk-cleanup/client
     */
    const { Switch, SettingsForm, SettingsFormModel, settingsNumberField, SettingsValueField } = require("@deepseek-ai/dsh-client-ui-primitives")
    const { jsx, jsxs } = require("react/jsx-runtime")
    /*
     * 客户端插件的身份（name / inject）由入口在 factory 里挂到 module.exports 上：
     * 宿主 ModuleLoader 读的就是这个导出对象，闭包产物里不能写 export。
     */

    /** 设置卡片挂在组合包页面上的键；必须是包名。 */
    const PLUGIN_PACKAGE = 'dsh-disk-cleanup'
    /** 配置表单的命名空间：该条目在 profile 里的 id。 */
    const SETTINGS_ENTRY_ID = 'dsh-disk-cleanup'
    /** 本地化命名空间。 */
    const NS = 'disk-cleanup'

    /** 文案。宿主界面是中文，随宿主语言只给一份中文。 */
    const MESSAGES = {
      zh: {
        'cleanup.title': '过期清理',
        'cleanup.on': '开启后按保留天数自动清理 scratch 目录里过期的临时文件。',
        'cleanup.off': '关闭后不再自动清理，临时文件会一直留着。',
        'cleanup.maxAge': '保留天数',
        'cleanup.maxAge.hint': 'scratch 里超过这么多天没改动过的条目会被删除。',
        'cleanup.invalid': '请填一个正整数，或留空使用默认值。',
        'cleanup.overridden': '已覆盖',
        'cleanup.reset': '恢复默认',
        'cleanup.save': '保存',
        'cleanup.saving': '保存中…',
        'cleanup.saveFailed': '宿主没有接受这些值，已保留以便重试。',
        'cleanup.readonly': '当前配置为只读，无法修改。',
        'cleanup.unavailable': '插件当前未启用，暂时无法配置。',
      },
    }

    /**
     * 布尔字段：开关写 'true' / 'false' 文本，再由 parse 变成真正的布尔值。
     * @param {string} field - 字段名。
     * @returns {object} 字段转换规则。
     */
    function booleanField(field) {
      return {
        field,
        format: value => String(value !== false),
        parse: text => ({ kind: 'set', value: text === 'true' }),
      }
    }

    /**
     * 表单外框的文案。
     * @param {(key: string) => string} t - 翻译函数。
     * @returns {object} SettingsForm 需要的标签。
     */
    function formLabels(t) {
      return {
        unavailable: t('cleanup.unavailable'),
        readOnly: t('cleanup.readonly'),
        saveFailed: t('cleanup.saveFailed'),
        save: t('cleanup.save'),
        saving: t('cleanup.saving'),
      }
    }

    /**
     * 建表单模型，并投影出卡片要读的状态。
     * @param {object} scope - 宿主该条目的配置表单。
     * @returns {{form: object, store: object}} 表单模型与快照存储。
     */
    function settingsForm(scope) {
      const form = new SettingsFormModel(scope, [
        booleanField('autoCleanup'),
        settingsNumberField('cleanupMaxAgeDays'),
      ])
      return {
        form,
        store: form.bind(() => ({
          ...form.shell(),
          enabled: form.field('autoCleanup'),
          maxAgeDays: form.field('cleanupMaxAgeDays'),
        })),
      }
    }

    /**
     * 设置卡片。
     * @param {object} props - 槽位注入的属性。
     * @returns {object | null} 卡片元素；摘要视图不渲染。
     */
    function SettingsCard(props) {
      const { t, useSettingsCard } = props
      const state = useSettingsCard(snapshot => snapshot)
      if (props.view === 'summary') return null
      const disabled = !state.writable || state.saving
      const enabled = state.enabled.text === 'true'
      return jsxs(SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
            children: [
              jsx('span', {
                style: { fontWeight: 600 },
                children: t('cleanup.title'),
              }),
              jsx(Switch, {
                checked: enabled,
                label: t('cleanup.title'),
                disabled,
                onChange: next => { props.edit('autoCleanup', String(next)) },
              }),
            ],
          }, 'toggle'),
          jsx('p', {
            style: { margin: '4px 0 12px', opacity: 0.7, fontSize: '12px' },
            children: t(enabled ? 'cleanup.on' : 'cleanup.off'),
          }, 'hint'),
          enabled
            ? jsx(SettingsValueField, {
              id: 'dsh-disk-cleanup-maxage',
              label: t('cleanup.maxAge'),
              hint: t('cleanup.maxAge.hint'),
              overriddenLabel: t('cleanup.overridden'),
              resetLabel: t('cleanup.reset'),
              invalidLabel: t('cleanup.invalid'),
              numeric: true,
              disabled,
              ...state.maxAgeDays,
              onEdit: text => { props.edit('cleanupMaxAgeDays', text) },
              onReset: () => { props.resetField('cleanupMaxAgeDays') },
            }, 'maxage')
            : null,
        ],
      })
    }

    /**
     * 客户端插件入口。
     * @param {object} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, MESSAGES), 'dsh-disk-cleanup 文案')
      const t = ctx.locale.bind(NS)
      const slots = ctx.slots
      const { store, form } = settingsForm(ctx.configForms.get(SETTINGS_ENTRY_ID))
      ctx.effect(() => () => { form.dispose() }, 'dsh-disk-cleanup 表单')
      slots.inject('plugins.bundle.config', () => slots.register({
        name: 'plugins.bundle.config',
        key: PLUGIN_PACKAGE,
        locale: NS,
        inject: () => ({ hooks: { settingsCard: store }, ...form.actions() }),
      }, SettingsCard))
    }

    module.exports.name = 'dsh-disk-cleanup'
    module.exports.inject = ['slots', 'locale', 'configForms']
    module.exports.apply = apply
    return module.exports;
  },
});
