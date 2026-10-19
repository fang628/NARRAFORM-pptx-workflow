// Editing stays available while only page design specifications are being generated.
export const designEditingActive=p=>p?.task?.status==='running'&&p.task.contentEditing===true;
export const designOutputBusy=(p,index)=>designEditingActive(p)&&(p.task.designIndices||[]).includes(Number(index));
export const concurrentDesignEditActions=new Set(['saveContent','syncPageDesignText','approveContent','confirmPageLayout','savePageDesign','approvePageDesign']);
