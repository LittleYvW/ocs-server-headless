/** Built-in Playwright automation. This entry point has no Electron dependency. */
export { AutomationScripts, LegacyScriptMappings } from './src/automation';
export { CXLoginScript } from './src/automation/wk/cx';
export { ZHSLoginScript } from './src/automation/wk/zhs';
export { ICVELoginScript } from './src/automation/wk/icve';
export { ZJYLoginScript } from './src/automation/wk/zjy';
export { ICourseLoginScript } from './src/automation/wk/icourse';
export { NewPageScript } from './src/automation/common';
export type { OCROptions as ICVEOCROptions } from './src/automation/wk/icve';
export type { OCROptions as ZJYOCROptions } from './src/automation/wk/zjy';
export type { OCROptions as ICOURSEOCROptions } from './src/automation/wk/icourse';
export { slowType, breakVerifyCode, breakSliderVerify, getBase64, ensureWideViewport } from './src/automation/utils';
