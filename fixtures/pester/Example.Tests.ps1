#Requires -Modules Pester

# Minimal passing suite that dogfoods the reusable Pester workflow: it proves the
# wiring (runner provisioned, pinned Pester installed and imported, the caller's
# run command executes and the result gates) without a real product test suite.

Describe 'pester reusable workflow dogfood' {
    It 'evaluates a passing assertion' {
        (2 + 2) | Should -Be 4
    }

    It 'runs under the imported Pester module' {
        Get-Module -Name Pester | Should -Not -BeNullOrEmpty
    }
}
