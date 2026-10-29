import { CXLoginScript } from './wk/cx';
import { ZHSLoginScript } from './wk/zhs';
import { ICVELoginScript } from './wk/icve';
import { ZJYLoginScript } from './wk/zjy';
import { ICourseLoginScript } from './wk/icourse';
import { NewPageScript } from './common';
import type { AutomationScript, RunFunction } from '../scripts/script';
import type { Config } from '../scripts/interface';

/** Config schemas stay typed while the registry accommodates each script's own run arguments. */
type RegisteredAutomationScript = AutomationScript<Record<string, Config>, RunFunction>;

export const AutomationScripts: RegisteredAutomationScript[] = [
	CXLoginScript,
	ZHSLoginScript,
	ZJYLoginScript,
	ICVELoginScript,
	ICourseLoginScript,
	NewPageScript
];

/**
 * 合并前独立登录脚本的兼容映射：旧配置名 → 合并后脚本 + 配置迁移。
 * 登录方式合并为一个设置项后，旧配置仍能正常执行（登录方式由迁移补全）。
 */
export const LegacyScriptMappings: {
	names: string[];
	script: RegisteredAutomationScript;
	migrate: (configs: Record<string, any>) => Record<string, any>;
}[] = [
	{
		names: ['超星-手机密码登录'],
		script: CXLoginScript,
		migrate: (configs) => ({ ...configs, loginType: 'phone' })
	},
	{
		names: ['超星-学校机构登录'],
		script: CXLoginScript,
		migrate: (configs) => ({ ...configs, loginType: 'unit' })
	},
	{
		names: ['智慧树-手机密码登录'],
		script: ZHSLoginScript,
		migrate: (configs) => ({ ...configs, loginType: 'phone' })
	},
	{
		names: ['智慧树-学校登录'],
		script: ZHSLoginScript,
		migrate: (configs) => ({ ...configs, loginType: 'unit' })
	},
	// 「自动登录」改名前的过渡映射：已保存的合并后脚本名（配置中已含 loginType）
	{
		names: ['超星-登录'],
		script: CXLoginScript,
		migrate: (configs) => ({ ...configs, loginType: configs.loginType ?? 'phone' })
	},
	{
		names: ['智慧树-登录'],
		script: ZHSLoginScript,
		migrate: (configs) => ({ ...configs, loginType: configs.loginType ?? 'phone' })
	}
];
