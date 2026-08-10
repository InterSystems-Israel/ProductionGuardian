/// DEPRECATED — no longer used.
/// The FHIRTransform process and this routing rule were replaced by:
///   ProductionGuardian.LabDemo.Process.PIDExtractProcess  (Business Process)
///   ProductionGuardian.LabDemo.Transform.HL7ToPID         (DTL)
///   ProductionGuardian.LabDemo.Operation.PatientDemographicsOperation (Operation)
///
/// This file is kept only because the file cannot be deleted from source control here.
/// Do not load or reference this class.
Class ProductionGuardian.LabDemo.FHIRRoutingRule Extends Ens.Rule.Definition [ Deprecated ]
{

Parameter RuleAssistClass = "EnsLib.MsgRouter.RuleAssist";

XData RuleDefinition [ XMLNamespace = "http://www.intersystems.com/rule" ]
{
<ruleDefinition alias="" context="EnsLib.MsgRouter.RoutingEngine" production="ProductionGuardian.LabDemo.Production">
  <ruleSet name="" effectiveBegin="" effectiveEnd="">
  </ruleSet>
</ruleDefinition>
}

}
