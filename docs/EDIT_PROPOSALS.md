# Edit proposals and hunk approval

`createEditProposal` computes a line-based proposal without modifying the workspace. Each contiguous change is a separate hunk with an independent approval flag.

`applyApprovedHunks` reconstructs a candidate result from the original text. With no approvals it returns the original text; only explicitly approved hunks contribute proposed lines. A later editor integration must still show the resulting text through native VS Code diff APIs before writing it.

