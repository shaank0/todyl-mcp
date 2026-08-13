import { devicePostureSummaryTool } from './posture.js';
import { getDeviceTool, listDevicesTool } from './devices.js';
import { listDeploymentGroupsTool } from './groups.js';
import { listInvoicesTool } from './invoices.js';
import { tenantReportTool } from './report.js';
import type { TodylTool } from './result.js';

export const TODYL_TOOLS: TodylTool[] = [
  listDevicesTool,
  getDeviceTool,
  devicePostureSummaryTool,
  listDeploymentGroupsTool,
  listInvoicesTool,
  tenantReportTool,
];

export type { TodylTool };
