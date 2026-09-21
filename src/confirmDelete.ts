export function confirmDelete(target: string): boolean {
  return window.confirm(`确定删除${target}吗？此操作无法撤销。`);
}
