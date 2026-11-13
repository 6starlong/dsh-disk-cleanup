/**
 * 冒烟检查：Config 能被真实的 schemastery 构建出字段表，默认值与实际生效的一致。
 *
 * schemastery 随 DSH 分发，插件以 link 装进 profile 时自身解析不到它，
 * 所以本文件要在 profile 目录里跑（见 README 的测试一节）；
 * 放在仓库里跑也能过，只是退化成空壳构建器。
 */
import { Config, DEFAULT_CONFIG } from '../lib/config.js'
import { schemaReady } from '../lib/schema.js'

const ready = schemaReady()
console.log('schemastery 已加载:', ready)

if (ready) {
  const fields = {}
  for (const [key, value] of Object.entries(Config.dict ?? {})) {
    const meta = value.meta ?? {}
    fields[key] = {
      type: value.type,
      volatile: meta.volatile === true,
      ...meta.default === undefined ? {} : { default: meta.default },
      ...meta.min === undefined ? {} : { min: meta.min },
      ...meta.max === undefined ? {} : { max: meta.max },
    }
  }
  console.log(JSON.stringify(fields, null, 2))
}

// 设置页显示的是 schema 默认值，插件实际用的是 DEFAULT_CONFIG，两者必须一致。
const fromSchema = ready ? Config({}) : {}
const mismatch = Object.keys(DEFAULT_CONFIG).filter((key) => {
  const value = fromSchema[key]
  const plain = value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? Reflect.apply(value.get, value, [])
    : value
  return plain !== DEFAULT_CONFIG[key]
})
console.log('默认值与 schema 不一致的字段:', mismatch.length === 0 ? '无' : mismatch.join(', '))
console.log('生效中的默认配置:', JSON.stringify(DEFAULT_CONFIG))
process.exitCode = ready && mismatch.length === 0 ? 0 : 1
