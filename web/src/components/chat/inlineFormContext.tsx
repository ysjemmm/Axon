/**
 * 内联表单提交通道
 *
 * 为什么需要 Context：AI 在回复里直接给出一块表单（```form axon-render），这块面板渲染在
 * 消息流深处（MarkdownRenderer → hydrate 出来的 React root），而"把提交结果作为一条用户消息
 * 发给 AI"的能力只在会话层（useChatSession）手里。一路 prop drilling 下去要穿过
 * MessageBubble → AssistantTurn → renderSegments → MarkdownRenderer 五层，用 Context 下发最省事
 * ——与 commandApprovalContext 同一套做法。
 *
 * 与阻塞式（ask_form 工具）的区别：那条有挂起门，提交会 resolve 掉等待中的工具调用；
 * 这条没有等待者——表单提交就是一条新的用户消息，AI 收到后照常回应。
 */

import { createContext, useContext } from "react";
import type { FormSpecData, FormSubmitData } from "./formTypes";

export interface InlineFormContextValue {
  /** 提交内联表单：把值整理成一条用户消息发给 AI */
  submit: (spec: FormSpecData, payload: FormSubmitData) => void;
}

export const InlineFormContext = createContext<InlineFormContextValue>({
  submit: () => {
    /* 默认空实现：没接上通道时（如历史消息预览）表单仍可填写，只是点了不生效 */
  },
});

export function useInlineForm(): InlineFormContextValue {
  return useContext(InlineFormContext);
}
