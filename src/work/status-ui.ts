import type { WorkStatus } from './service.ts';

export const workStatusLabels: Record<WorkStatus,string> = {
  active:'进行中', paused:'已暂停', completed:'已完成', closed:'已关闭',
};
export const workStatusDescriptions: Record<WorkStatus,string> = {
  active:'继续推进这项工作。',
  paused:'暂时搁置，之后可以继续。',
  completed:'工作目标已达成，由你确认完成。',
  closed:'这项工作不再推进。',
};
